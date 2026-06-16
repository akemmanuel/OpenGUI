/**
 * Renders the chat message list for the active session.
 * Handles user messages, assistant text, tool calls, and permission requests.
 */

import { Undo2 } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { InteractionRequestsView } from "@/components/message-list/interactions/InteractionRequestsView";
import { MessageBubble } from "@/components/message-list/MessageBubble";
import {
  type ScrollSnapshot,
  VirtualMessageScroller,
} from "@/components/message-list/VirtualMessageScroller";
import type { TurnFooter } from "@/components/message-list/types";
import { Spinner } from "@/components/ui/spinner";
import { useBackendCapabilities } from "@/hooks/use-agent-backend";
import {
  type MessageEntry,
  useActions,
  useMessages,
  useSessionState,
} from "@/hooks/use-agent-state";
import type { TurnRun } from "@/hooks/agent-state-types";
import type { TextTranscriptPart, TranscriptPart } from "@/protocol/session-transcript";
import logoDark from "../../opengui-dark.svg";
import logoLight from "../../opengui-light.svg";

/** Part types that actually render something visible. */
const RENDERABLE_TYPES = new Set(["text", "reasoning", "tool", "file"]);
/** Check if a part will produce visible output. */
function isRenderablePart(part: TranscriptPart): boolean {
  if (!RENDERABLE_TYPES.has(part.type)) return false;
  // text parts with empty content render nothing
  if (part.type === "text" && !part.text?.trim()) return false;
  return true;
}

/** Check if a message entry has any visible content (renderable parts or error). */
function hasVisibleContent(entry: MessageEntry): boolean {
  if (entry.parts.some(isRenderablePart)) return true;
  // Assistant messages with errors should stay visible
  if (entry.info.role === "assistant" && entry.info.error) return true;
  // Messages with no parts yet (still loading) should stay visible
  if (entry.parts.length === 0) return true;
  return false;
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function getEntryText(entry: MessageEntry): string {
  return entry.parts
    .filter((part) => part.type === "text" && typeof part.text === "string")
    .map((part) => (part as TextTranscriptPart).text)
    .join("\n")
    .trim();
}

const SYSTEM_APPEND_RE = /^\s*<SYSTEM-APPEND>[\s\S]*?<\/SYSTEM-APPEND>\s*/;

function stripLeadingSystemAppend(entry: MessageEntry): MessageEntry {
  if (entry.info.role !== "user") return entry;
  let stripped = false;
  const parts = entry.parts.map((part) => {
    if (stripped || part.type !== "text" || typeof part.text !== "string") {
      return part;
    }
    const nextText = part.text.replace(SYSTEM_APPEND_RE, "");
    if (nextText === part.text) return part;
    stripped = true;
    return { ...part, text: nextText };
  });
  return stripped ? { ...entry, parts } : entry;
}

function RevertBanner({
  revertedCount,
  onRestore,
}: {
  revertedCount: number;
  onRestore: () => void;
}) {
  const { t } = useTranslation();
  return (
    <div className="flex items-center gap-2 mt-4 select-none">
      <div className="flex-1 h-px bg-orange-500/30" />
      <div className="flex items-center gap-2 text-[11px] text-orange-500/80 font-mono">
        <Undo2 className="size-3" />
        <span>{t("revertBanner.reverted", { count: revertedCount })}</span>
        <span className="text-orange-500/50">|</span>
        <button
          type="button"
          onClick={onRestore}
          className="hover:text-orange-500 transition-colors cursor-pointer"
        >
          {t("revertBanner.restore")}
        </button>
      </div>
      <div className="flex-1 h-px bg-orange-500/30" />
    </div>
  );
}

export function MessageList({ detachedProject: _detachedProject }: { detachedProject?: string }) {
  const {
    respondPermission,
    replyQuestion,
    rejectQuestion,
    forkFromMessage,
    revertToMessage,
    unrevert,
    loadOlderMessages,
  } = useActions();
  const capabilities = useBackendCapabilities();
  const {
    isBusy,
    isLoadingMessages,
    pendingPermissions,
    pendingQuestions,
    activeSessionId,
    sessions,
    activeTargetDirectory,
    sessionMeta,
  } = useSessionState();
  const { messages, turnRuns, messageHistoryHasMore, isLoadingOlderMessages } = useMessages();
  const activeSession = useMemo(
    () => sessions.find((s) => s.id === activeSessionId),
    [sessions, activeSessionId],
  );
  const revertMessageID = activeSession?.revert?.messageID;
  const pendingPermission = activeSessionId ? (pendingPermissions[activeSessionId] ?? null) : null;
  const pendingQuestion = activeSessionId ? (pendingQuestions[activeSessionId] ?? null) : null;

  const [expandedUserMessages, setExpandedUserMessages] = useState<Set<string>>(() => new Set());
  const [expandedToolCalls, setExpandedToolCalls] = useState<Set<string>>(() => new Set());
  const scrollSnapshotsRef = useRef(new Map<string, ScrollSnapshot>());

  useEffect(() => {
    const validSessionIds = new Set(sessions.map((session) => session.id));
    for (const sessionId of scrollSnapshotsRef.current.keys()) {
      if (!validSessionIds.has(sessionId)) scrollSnapshotsRef.current.delete(sessionId);
    }
  }, [sessions]);

  // ---- visible messages (filter out step-only / empty entries) ----

  const visibleMessages = useMemo(() => {
    let rendered = messages.filter(hasVisibleContent);
    const hiddenBootstrapPrefix = activeSessionId
      ? (sessionMeta[activeSessionId]?.hiddenBootstrapPrefix ?? null)
      : null;
    if (hiddenBootstrapPrefix) {
      let bootstrapComplete = false;
      rendered = rendered.filter((entry) => {
        if (bootstrapComplete) return true;
        if (entry.info.role === "user" && getEntryText(entry).startsWith(hiddenBootstrapPrefix)) {
          return false;
        }
        if (entry.info.role === "user") {
          bootstrapComplete = true;
          return true;
        }
        return false;
      });
    }
    if (activeSessionId && sessionMeta[activeSessionId]?.hideSystemAppendBlocks) {
      rendered = rendered.map(stripLeadingSystemAppend);
    }

    if (!revertMessageID) return rendered;
    // Hide messages at or after the revert point
    return rendered.filter((m) => m.info.id < revertMessageID);
  }, [messages, revertMessageID, activeSessionId, sessionMeta]);

  // Count reverted messages for the banner
  const revertedCount = useMemo(() => {
    if (!revertMessageID) return 0;
    return messages.filter((m) => hasVisibleContent(m) && m.info.id >= revertMessageID).length;
  }, [messages, revertMessageID]);

  const turnFooterByMessageId = useMemo(() => {
    const footerByMessageId = new Map<string, TurnFooter>();

    type AssistantTurn = {
      user?: MessageEntry;
      assistants: MessageEntry[];
    };

    const assistantTurns: AssistantTurn[] = [];
    let currentTurn: AssistantTurn | null = null;

    const flushTurn = () => {
      if (currentTurn?.assistants.length) assistantTurns.push(currentTurn);
    };

    for (const entry of visibleMessages) {
      if (entry.info.role === "user") {
        flushTurn();
        currentTurn = { user: entry, assistants: [] };
        continue;
      }
      if (entry.info.role !== "assistant") continue;
      if (!currentTurn) currentTurn = { assistants: [] };
      currentTurn.assistants.push(entry);
    }
    flushTurn();

    const latestAssistantForRun = (turn: TurnRun) => {
      const byBoundMessage = assistantTurns.find((candidate) =>
        candidate.assistants.some((entry) => entry.info.id === turn.assistantMessageID),
      );
      if (byBoundMessage) return byBoundMessage.assistants.at(-1);

      const byTime = assistantTurns.find((candidate) => {
        const firstAssistant = candidate.assistants[0];
        const lastAssistant = candidate.assistants.at(-1);
        if (!firstAssistant || !lastAssistant) return false;
        const firstCreated = firstAssistant.info.time.created;
        const lastCreated = lastAssistant.info.time.created;
        return lastCreated >= turn.startedAt && firstCreated <= (turn.completedAt ?? Date.now());
      });
      return byTime?.assistants.at(-1);
    };

    for (const turn of Object.values(turnRuns)) {
      const matchingAssistantId = latestAssistantForRun(turn)?.info.id;
      if (!matchingAssistantId) continue;
      footerByMessageId.set(matchingAssistantId, {
        startedAt: turn.startedAt,
        completedAt: turn.completedAt,
        running: turn.status === "running",
        providerID: turn.providerID,
        modelID: turn.modelID,
        thinkingLevel: turn.thinkingLevel,
      });
    }

    for (const assistantTurn of assistantTurns) {
      const entry = assistantTurn.assistants.at(-1);
      if (!entry) continue;
      if (footerByMessageId.has(entry.info.id)) continue;

      const assistantWithProvider = assistantTurn.assistants.findLast(
        (item) => "providerID" in item.info && typeof item.info.providerID === "string",
      );
      const assistantWithModel = assistantTurn.assistants.findLast(
        (item) => "modelID" in item.info && typeof item.info.modelID === "string",
      );
      const assistantWithVariant = assistantTurn.assistants.findLast(
        (item) => "variant" in item.info && nonEmptyString(item.info.variant),
      );
      const providerID =
        assistantWithProvider && "providerID" in assistantWithProvider.info
          ? assistantWithProvider.info.providerID
          : undefined;
      const modelID =
        assistantWithModel && "modelID" in assistantWithModel.info
          ? assistantWithModel.info.modelID
          : undefined;
      const completedAssistant = assistantTurn.assistants.findLast(
        (item) => typeof (item.info.time as { completed?: number }).completed === "number",
      );
      const completedAt = completedAssistant
        ? (completedAssistant.info.time as { completed?: number }).completed
        : undefined;
      const parent = assistantTurn.user;
      const parentModel =
        parent?.info.role === "user" && "model" in parent.info ? parent.info.model : null;
      const thinkingLevel =
        (assistantWithVariant && "variant" in assistantWithVariant.info
          ? nonEmptyString(assistantWithVariant.info.variant)
          : undefined) ??
        (parentModel && typeof parentModel === "object" && "variant" in parentModel
          ? nonEmptyString(parentModel.variant)
          : undefined);
      const durationMs =
        typeof completedAt === "number" && parent?.info.role === "user"
          ? completedAt - parent.info.time.created
          : undefined;

      if (!providerID && !modelID && !thinkingLevel && !(durationMs && durationMs > 0)) continue;

      footerByMessageId.set(entry.info.id, {
        durationMs: durationMs && durationMs > 0 ? durationMs : undefined,
        running: false,
        providerID,
        modelID,
        thinkingLevel,
      });
    }

    return footerByMessageId;
  }, [visibleMessages, turnRuns]);

  const firstUserMessageIndex = useMemo(
    () => visibleMessages.findIndex((message) => message.info.role === "user"),
    [visibleMessages],
  );
  const toggleUserMessage = useCallback((messageId: string) => {
    setExpandedUserMessages((current) => {
      const next = new Set(current);
      if (next.has(messageId)) next.delete(messageId);
      else next.add(messageId);
      return next;
    });
  }, []);

  const toggleToolCall = useCallback((partId: string, expanded: boolean) => {
    setExpandedToolCalls((current) => {
      const next = new Set(current);
      if (expanded) next.add(partId);
      else next.delete(partId);
      return next;
    });
  }, []);

  const renderMessageBubble = useCallback(
    (entry: MessageEntry, idx: number) => {
      const prev = idx > 0 ? (visibleMessages[idx - 1] ?? null) : null;
      const isConsecutive = prev !== null && prev.info.role === entry.info.role;
      const spacing =
        idx === 0 ? "" : entry.parts.length === 0 ? "" : isConsecutive ? "mt-1" : "mt-4";
      const isFirstUserMsg = entry.info.role === "user" && firstUserMessageIndex === idx;

      return (
        <div key={entry.info.id} className={spacing}>
          <MessageBubble
            entry={entry}
            turnFooter={turnFooterByMessageId.get(entry.info.id)}
            onFork={
              capabilities?.fork && entry.info.role === "user" && !isFirstUserMsg
                ? () => forkFromMessage(entry.info.id)
                : undefined
            }
            onRevert={
              capabilities?.revert && entry.info.role === "user"
                ? () => revertToMessage(entry.info.id)
                : undefined
            }
            expandedUserMessages={expandedUserMessages}
            expandedToolCalls={expandedToolCalls}
            onToggleUserMessage={toggleUserMessage}
            onToggleToolCall={toggleToolCall}
          />
        </div>
      );
    },
    [
      firstUserMessageIndex,
      visibleMessages,
      turnFooterByMessageId,
      forkFromMessage,
      revertToMessage,
      expandedUserMessages,
      expandedToolCalls,
      toggleUserMessage,
      toggleToolCall,
      capabilities,
    ],
  );

  if (isLoadingMessages && visibleMessages.length === 0) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <Spinner className="size-6 text-muted-foreground" />
      </div>
    );
  }

  const isDraft = !activeSessionId && !!activeTargetDirectory;

  if (isDraft || !activeSessionId || (visibleMessages.length === 0 && !isBusy)) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <div className="w-full max-w-3xl flex flex-col items-center">
          <img
            src={logoDark}
            alt="OpenGUI"
            draggable={false}
            className="hidden dark:block w-82 select-none pointer-events-none"
          />
          <img
            src={logoLight}
            alt="OpenGUI"
            draggable={false}
            className="dark:hidden w-82 select-none pointer-events-none"
          />
        </div>
      </div>
    );
  }

  const trailingContent = (
    <>
      {capabilities?.revert && revertMessageID && revertedCount > 0 && (
        <RevertBanner revertedCount={revertedCount} onRestore={unrevert} />
      )}

      <InteractionRequestsView
        permission={capabilities?.permissions ? pendingPermission : null}
        question={capabilities?.questions ? pendingQuestion : null}
        onRespondPermission={respondPermission}
        onReplyQuestion={replyQuestion}
        onRejectQuestion={rejectQuestion}
      />
    </>
  );

  return (
    <VirtualMessageScroller
      key={activeSessionId}
      scrollKey={activeSessionId}
      scrollSnapshotsRef={scrollSnapshotsRef}
      messages={visibleMessages}
      isBusy={isBusy}
      hasOlder={messageHistoryHasMore}
      isLoadingOlder={isLoadingOlderMessages}
      loadOlder={loadOlderMessages}
      renderMessage={renderMessageBubble}
      trailingContent={trailingContent}
    />
  );
}
