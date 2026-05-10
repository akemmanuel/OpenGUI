/**
 * Renders the chat message list for the active session.
 * Handles user messages, assistant text, tool calls, and permission requests.
 */

import type { Part, TextPart } from "@opencode-ai/sdk/v2/client";
import { useVirtualizer } from "@tanstack/react-virtual";
import { ShieldAlert, Undo2 } from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef } from "react";
import { QuestionPanel } from "@/components/message-list/QuestionPanel";
import { MessageBubble } from "@/components/message-list/MessageBubble";
import type { TurnFooter } from "@/components/message-list/types";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { useBackendCapabilities } from "@/hooks/use-agent-backend";
import {
  type MessageEntry,
  useActions,
  useMessages,
  useSessionState,
} from "@/hooks/use-agent-state";
import { NEAR_BOTTOM_PX } from "@/lib/constants";
import logoDark from "../../opengui-dark.svg";
import logoLight from "../../opengui-light.svg";

/** Part types that actually render something visible. */
const RENDERABLE_TYPES = new Set(["text", "reasoning", "tool", "file"]);
const VIRTUALIZATION_MESSAGE_THRESHOLD = 60;
const VIRTUALIZATION_OVERSCAN_IDLE = 12;
const VIRTUALIZATION_OVERSCAN_BUSY = 16;

/** Check if a part will produce visible output. */
function isRenderablePart(part: Part): boolean {
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
  return (entry.parts as TextPart[])
    .filter((part) => part.type === "text" && typeof part.text === "string")
    .map((part) => part.text)
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
  return (
    <div className="flex items-center gap-2 mt-4 select-none">
      <div className="flex-1 h-px bg-orange-500/30" />
      <div className="flex items-center gap-2 text-[11px] text-orange-500/80 font-mono">
        <Undo2 className="size-3" />
        <span>
          {revertedCount} message{revertedCount !== 1 ? "s" : ""} reverted
        </span>
        <span className="text-orange-500/50">|</span>
        <button
          type="button"
          onClick={onRestore}
          className="hover:text-orange-500 transition-colors cursor-pointer"
        >
          Restore
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
    draftSessionDirectory,
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

  const listRef = useRef<HTMLDivElement>(null);
  /** Whether the user is currently near the bottom of the scroll container. */
  const isNearBottomRef = useRef(true);
  /** Set to true while we are programmatically scrolling to avoid the onScroll handler unsetting sticky. */
  const isProgrammaticScrollRef = useRef(false);
  /** RAF handle so we batch at most one scroll per frame. */
  const rafRef = useRef<number | null>(null);
  const prevSessionRef = useRef<string | null>(null);
  const sessionJustSwitchedRef = useRef(false);
  /** Sentinel element at the top of the list for triggering older message loads. */
  const topSentinelRef = useRef<HTMLDivElement>(null);
  /** Track message count before a prepend so we can preserve scroll position. */
  const prevMessageCountRef = useRef(0);

  // ---- auto-load older messages when scrolled near the top ----

  useEffect(() => {
    const sentinel = topSentinelRef.current;
    const scrollContainer = listRef.current;
    if (!sentinel || !scrollContainer) return;

    const observer = new IntersectionObserver(
      (entries) => {
        const entry = entries[0];
        if (entry?.isIntersecting && messageHistoryHasMore && !isLoadingOlderMessages) {
          // Snapshot scroll metrics before prepend
          prevMessageCountRef.current = scrollContainer.scrollHeight;
          void loadOlderMessages();
        }
      },
      { root: scrollContainer, rootMargin: "200px 0px 0px 0px", threshold: 0 },
    );
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [messageHistoryHasMore, isLoadingOlderMessages, loadOlderMessages]);

  // ---- preserve scroll position after older messages are prepended ----
  // We use a MutationObserver on the scroll container's childList to detect
  // when older messages are inserted. This avoids lint issues with effect
  // dependencies while still firing synchronously before paint.

  useLayoutEffect(() => {
    const el = listRef.current;
    if (!el) return;
    const observer = new MutationObserver(() => {
      if (prevMessageCountRef.current === 0) return;
      const prevScrollHeight = prevMessageCountRef.current;
      const newScrollHeight = el.scrollHeight;
      if (newScrollHeight > prevScrollHeight) {
        isProgrammaticScrollRef.current = true;
        el.scrollTop += newScrollHeight - prevScrollHeight;
        requestAnimationFrame(() => {
          isProgrammaticScrollRef.current = false;
        });
      }
      prevMessageCountRef.current = 0;
    });
    observer.observe(el, { childList: true, subtree: true });
    return () => observer.disconnect();
  }, []);

  // ---- helpers ----

  const checkNearBottom = useCallback(() => {
    const el = listRef.current;
    if (!el) return true;
    return el.scrollHeight - el.scrollTop - el.clientHeight <= NEAR_BOTTOM_PX;
  }, []);

  const scrollToBottom = useCallback(() => {
    if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
    rafRef.current = requestAnimationFrame(() => {
      rafRef.current = null;
      const el = listRef.current;
      if (!el) return;
      isProgrammaticScrollRef.current = true;
      el.scrollTop = el.scrollHeight;
      // Reset programmatic flag after the browser has had time to fire the scroll event.
      requestAnimationFrame(() => {
        isProgrammaticScrollRef.current = false;
      });
    });
  }, []);

  // ---- onScroll: track whether user scrolled away ----

  const handleScroll = useCallback(() => {
    if (isProgrammaticScrollRef.current) return;
    isNearBottomRef.current = checkNearBottom();
  }, [checkNearBottom]);

  // ---- session switch: mark flag so the layout effect can scroll before paint ----

  useLayoutEffect(() => {
    if (activeSessionId !== prevSessionRef.current) {
      prevSessionRef.current = activeSessionId;
      isNearBottomRef.current = true;
      sessionJustSwitchedRef.current = true;
    }
  }, [activeSessionId]);

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
    const visibleMessageIds = new Set(visibleMessages.map((entry) => entry.info.id));
    const sessionThinkingLevel =
      nonEmptyString(activeSession?.model?.variant) ??
      (activeSessionId ? nonEmptyString(sessionMeta[activeSessionId]?.selectedVariant) : undefined);

    for (const turn of Object.values(turnRuns)) {
      const matchingAssistantId =
        turn.assistantMessageID && visibleMessageIds.has(turn.assistantMessageID)
          ? turn.assistantMessageID
          : visibleMessages.findLast(
              (entry) =>
                entry.info.role === "assistant" && entry.info.time.created >= turn.startedAt,
            )?.info.id;
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

    const latestAssistantByParentId = new Map<string, MessageEntry>();
    for (const entry of visibleMessages) {
      if (entry.info.role !== "assistant") continue;
      const parentId = "parentID" in entry.info ? entry.info.parentID : undefined;
      if (!parentId) continue;
      latestAssistantByParentId.set(parentId, entry);
    }

    for (const entry of latestAssistantByParentId.values()) {
      if (footerByMessageId.has(entry.info.id)) continue;

      const providerID =
        "providerID" in entry.info && typeof entry.info.providerID === "string"
          ? entry.info.providerID
          : undefined;
      const modelID =
        "modelID" in entry.info && typeof entry.info.modelID === "string"
          ? entry.info.modelID
          : undefined;
      const completedAt = (entry.info.time as { completed?: number }).completed;
      const parentId = "parentID" in entry.info ? entry.info.parentID : undefined;
      const parent = visibleMessages.find((item) => item.info.id === parentId);
      const parentModel =
        parent?.info.role === "user" && "model" in parent.info ? parent.info.model : null;
      const thinkingLevel =
        ("variant" in entry.info ? nonEmptyString(entry.info.variant) : undefined) ??
        (parentModel && typeof parentModel === "object" && "variant" in parentModel
          ? nonEmptyString(parentModel.variant)
          : undefined) ??
        sessionThinkingLevel;
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
  }, [visibleMessages, turnRuns, activeSession, activeSessionId, sessionMeta]);

  // Find the last reasoning part across all assistant messages so we can
  // auto-collapse earlier reasoning blocks when a new one starts.
  const lastReasoningPartId = useMemo(() => {
    for (let i = visibleMessages.length - 1; i >= 0; i--) {
      const entry = visibleMessages[i];
      if (!entry || entry.info.role !== "assistant") continue;
      for (let j = entry.parts.length - 1; j >= 0; j--) {
        const part = entry.parts[j];
        if (part?.type === "reasoning") return part.id;
      }
    }
    return undefined;
  }, [visibleMessages]);
  const firstUserMessageIndex = useMemo(
    () => visibleMessages.findIndex((message) => message.info.role === "user"),
    [visibleMessages],
  );
  const shouldVirtualizeMessages = visibleMessages.length >= VIRTUALIZATION_MESSAGE_THRESHOLD;
  const messageVirtualizer = useVirtualizer<HTMLDivElement, HTMLDivElement>({
    count: visibleMessages.length,
    enabled: shouldVirtualizeMessages,
    getScrollElement: () => listRef.current,
    getItemKey: (index) => visibleMessages[index]?.info.id ?? index,
    estimateSize: (index) => (visibleMessages[index]?.info.role === "user" ? 96 : 220),
    overscan: isBusy ? VIRTUALIZATION_OVERSCAN_BUSY : VIRTUALIZATION_OVERSCAN_IDLE,
    useAnimationFrameWithResizeObserver: true,
  });
  const virtualItems = shouldVirtualizeMessages ? messageVirtualizer.getVirtualItems() : [];
  const virtualHeight = shouldVirtualizeMessages ? messageVirtualizer.getTotalSize() : 0;

  const renderMessageBubble = useCallback(
    (entry: MessageEntry, idx: number) => {
      const prev = idx > 0 ? (visibleMessages[idx - 1] ?? null) : null;
      const isConsecutive = prev !== null && prev.info.role === entry.info.role;
      const spacing = idx === 0 ? "" : isConsecutive ? "mt-1.5" : "mt-4";
      const isFirstUserMsg = entry.info.role === "user" && firstUserMessageIndex === idx;

      return (
        <div key={entry.info.id} className={spacing}>
          <MessageBubble
            entry={entry}
            turnFooter={turnFooterByMessageId.get(entry.info.id)}
            lastReasoningPartId={lastReasoningPartId}
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
          />
        </div>
      );
    },
    [
      firstUserMessageIndex,
      visibleMessages,
      turnFooterByMessageId,
      lastReasoningPartId,
      forkFromMessage,
      revertToMessage,
    ],
  );

  // ---- session switch: jump to bottom synchronously before paint ----

  useLayoutEffect(() => {
    if (!sessionJustSwitchedRef.current) return;
    const el = listRef.current;
    if (!el || visibleMessages.length === 0) return;
    scrollToBottom();
    sessionJustSwitchedRef.current = false;
  }, [scrollToBottom, visibleMessages]);

  // ---- streaming / new content: scroll only if sticky ----

  useEffect(() => {
    // visibleMessages is intentionally in the dep array so this effect
    // re-fires on every streaming delta, keeping the view pinned to the
    // bottom while new tokens arrive.
    if (!visibleMessages.length) return;
    if (!isNearBottomRef.current) return;
    // Skip if we already handled this render in the layout effect above.
    if (sessionJustSwitchedRef.current) return;
    scrollToBottom();
  }, [scrollToBottom, visibleMessages]);

  if (isLoadingMessages && visibleMessages.length === 0) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <Spinner className="size-6 text-muted-foreground" />
      </div>
    );
  }

  const isDraft = !activeSessionId && !!draftSessionDirectory;

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

  return (
    <div ref={listRef} onScroll={handleScroll} className="flex-1 overflow-auto px-4 py-4">
      <div className="max-w-[640px] mx-auto">
        {/* Sentinel for auto-loading older messages */}
        {messageHistoryHasMore && <div ref={topSentinelRef} className="h-px w-full" />}
        {isLoadingOlderMessages && (
          <div className="flex items-center justify-center py-3">
            <Spinner className="size-4 text-muted-foreground" />
          </div>
        )}
        {visibleMessages.length > 0 && shouldVirtualizeMessages && (
          <div className="relative w-full" style={{ height: virtualHeight }}>
            {virtualItems.map((virtualItem) => {
              const entry = visibleMessages[virtualItem.index];
              if (!entry) return null;

              return (
                <div
                  key={virtualItem.key}
                  data-index={virtualItem.index}
                  ref={messageVirtualizer.measureElement}
                  className="absolute left-0 top-0 w-full"
                  style={{ transform: `translateY(${virtualItem.start}px)` }}
                >
                  {renderMessageBubble(entry, virtualItem.index)}
                </div>
              );
            })}
          </div>
        )}
        {visibleMessages.length > 0 && !shouldVirtualizeMessages && (
          <div>{visibleMessages.map((entry, index) => renderMessageBubble(entry, index))}</div>
        )}

        {/* Revert marker */}
        {capabilities?.revert && revertMessageID && revertedCount > 0 && (
          <RevertBanner revertedCount={revertedCount} onRestore={unrevert} />
        )}

        {/* Permission request */}
        {capabilities?.permissions && pendingPermission && (
          <div className="border rounded-lg p-4 bg-amber-500/10 border-amber-500/30 space-y-3">
            <div className="flex items-start gap-2">
              <ShieldAlert className="size-5 text-amber-500 shrink-0 mt-0.5" />
              <div className="space-y-1">
                <p className="text-sm font-medium">Permission: {pendingPermission.permission}</p>
                {pendingPermission.patterns.length > 0 && (
                  <p className="text-xs text-muted-foreground">
                    {pendingPermission.patterns.join(", ")}
                  </p>
                )}
              </div>
            </div>
            <div className="flex gap-2">
              <Button size="sm" variant="default" onClick={() => respondPermission("once")}>
                Allow once
              </Button>
              <Button size="sm" variant="secondary" onClick={() => respondPermission("always")}>
                Always allow
              </Button>
              <Button size="sm" variant="destructive" onClick={() => respondPermission("reject")}>
                Reject
              </Button>
            </div>
          </div>
        )}

        {/* Question request */}
        {capabilities?.questions && pendingQuestion && (
          <QuestionPanel
            questions={pendingQuestion.questions}
            onSubmit={(answers) => replyQuestion(answers)}
            onDismiss={() => rejectQuestion()}
          />
        )}
      </div>
    </div>
  );
}
