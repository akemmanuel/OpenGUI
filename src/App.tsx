import { AlertCircle, X } from "lucide-react";
import { useCallback, useEffect, useMemo } from "react";
import { QueueList } from "@/components/QueueList";
import { TodoSidebar } from "@/components/TodoSidebar";
import { UpdateDialog } from "@/components/UpdateDialog";
import { Button } from "@/components/ui/button";
import {
	RightSidebarProvider,
	SidebarInset,
	SidebarProvider,
} from "@/components/ui/sidebar";
import { Spinner } from "@/components/ui/spinner";
import {
	hasAnyConnection,
	OpenCodeProvider,
	resolveServerDefaultModel,
	useActions,
	useConnectionState,
	useModelState,
	useSessionState,
} from "@/hooks/use-opencode";
import { useUpdateCheck } from "@/hooks/use-update-check";
import { useSessionTodos } from "@/lib/todos";
import { computeTokenTotal } from "@/lib/utils";
import { AppSidebar } from "./components/AppSidebar";
import { MessageList } from "./components/MessageList";
import { PromptBox } from "./components/PromptBox";
import { TitleBar } from "./components/TitleBar";
import "./index.css";

function AppContent() {
	const {
		sendPrompt,
		abortSession,
		clearError,
		getQueuedPrompts,
		removeFromQueue,
		reorderQueue,
		updateQueuedPrompt,
		sendQueuedNow,
		cycleVariant,
		revertToMessage,
		unrevert,
	} = useActions();
	const {
		sessions,
		activeSessionId: sessionActiveId,
		messages,
		isBusy,
		isLoadingMessages,
		draftSessionDirectory,
	} = useSessionState();
	const { providers, selectedModel, providerDefaults } = useModelState();
	const { connections, bootState, bootError, lastError } = useConnectionState();

	// Find the active session object (for revert state)
	const activeSession = useMemo(
		() => sessions.find((s) => s.id === sessionActiveId),
		[sessions, sessionActiveId],
	);

	// Find the last user message (for undo keybind), respecting revert state
	const revertToLastMessage = useCallback(() => {
		const revertMsgId = activeSession?.revert?.messageID;
		const userMessages = messages.filter((m) => m.info.role === "user");
		// Find the last user message before the current revert point (or the very last)
		const target = revertMsgId
			? [...userMessages].reverse().find((m) => m.info.id < revertMsgId)
			: userMessages[userMessages.length - 1];
		if (target) revertToMessage(target.info.id);
	}, [activeSession, messages, revertToMessage]);

	// Ctrl+Z: undo last message; Ctrl+Shift+Z: redo
	useEffect(() => {
		const handleUndoRedo = (e: KeyboardEvent) => {
			if (e.key !== "z" || !(e.metaKey || e.ctrlKey)) return;
			// Don't intercept native undo/redo in text inputs
			const tag = (e.target as HTMLElement)?.tagName;
			if (tag === "INPUT" || tag === "TEXTAREA") return;
			e.preventDefault();
			if (e.shiftKey) {
				unrevert();
			} else {
				revertToLastMessage();
			}
		};
		window.addEventListener("keydown", handleUndoRedo);
		return () => window.removeEventListener("keydown", handleUndoRedo);
	}, [revertToLastMessage, unrevert]);

	// Ctrl+T: cycle model variant (low / medium / high / default)
	useEffect(() => {
		const handleKeyDown = (e: KeyboardEvent) => {
			if (e.key === "t" && (e.metaKey || e.ctrlKey)) {
				e.preventDefault();
				cycleVariant();
			}
		};
		window.addEventListener("keydown", handleKeyDown);
		return () => window.removeEventListener("keydown", handleKeyDown);
	}, [cycleVariant]);

	const activeSessionId = sessionActiveId;
	const queuedPrompts = activeSessionId
		? getQueuedPrompts(activeSessionId)
		: [];

	const isConnected = hasAnyConnection(connections);
	const isBooting =
		bootState === "checking-server" || bootState === "starting-server";

	// Compute context usage percentage from the last assistant message's total
	// token count and the model's context window limit.  "Total" includes
	// everything in the context window: system prompt, chat history, tool
	// calls/results, reasoning, cache - i.e. the full window footprint.
	//
	// Resolves the model from the last assistant message (most accurate),
	// then falls back to the UI-selected model, then provider defaults.
	const contextPercent = useMemo<number | null>(() => {
		if (!activeSessionId) return null;

		// Walk backwards to find the last assistant message with token info.
		// During streaming, the final message-level tokens may not be set yet,
		// so we also sum step-finish part tokens for a live estimate.
		type TokenSnapshot = {
			providerID: string;
			modelID: string;
			total: number;
		};
		let last: TokenSnapshot | null = null;
		for (let i = messages.length - 1; i >= 0; i--) {
			const msg = messages[i]?.info;
			if (
				msg?.role === "assistant" &&
				"providerID" in msg &&
				"modelID" in msg
			) {
				// First try message-level tokens (authoritative, set after completion)
				const t = "tokens" in msg ? msg.tokens : undefined;
				let total = t ? computeTokenTotal(t) : 0;

				// If no message-level tokens yet, sum step-finish parts (live during streaming)
				if (total <= 0) {
					const parts = messages[i]?.parts;
					if (parts) {
						for (const part of parts) {
							if (part.type === "step-finish" && "tokens" in part) {
								total += computeTokenTotal(part.tokens);
							}
						}
					}
				}

				if (total > 0) {
					last = { providerID: msg.providerID, modelID: msg.modelID, total };
					break;
				}
			}
		}

		// Resolve which model to use for the context limit
		let provID = last?.providerID ?? selectedModel?.providerID;
		let modID = last?.modelID ?? selectedModel?.modelID;
		if (!provID || !modID) {
			const fallback = resolveServerDefaultModel(providers, providerDefaults);
			if (fallback) {
				provID = fallback.providerID;
				modID = fallback.modelID;
			}
		}
		if (!provID || !modID) return null;

		const provider = providers.find((p) => p.id === provID);
		if (!provider) return null;
		const model = provider.models[modID];
		if (!model?.limit?.context) return null;
		const contextLimit = model.limit.context;

		// No assistant messages yet - show 0
		if (!last) return 0;

		return Math.min(
			100,
			Math.max(0, Math.round((last.total / contextLimit) * 100)),
		);
	}, [activeSessionId, messages, providers, selectedModel, providerDefaults]);

	// Extract the latest todo snapshot from the current session's messages
	const sessionTodos = useSessionTodos(messages);

	// Check for app updates on startup
	const updateCheck = useUpdateCheck();

	return (
		<SidebarProvider>
			<AppSidebar />
			<SidebarInset>
				<RightSidebarProvider className="flex-col">
					{/* Title bar spans full width */}
					<TitleBar todos={sessionTodos} />

					{/* Below title bar: content column + right sidebar in a row */}
					<div className="flex flex-1 min-h-0 min-w-0">
						<div className="flex-1 flex flex-col min-w-0 select-none">
							{/* Startup banner */}
							{isBooting && (
								<div className="flex items-center gap-2 px-4 py-2 border-b border-border text-sm text-muted-foreground bg-muted/30">
									<Spinner className="size-4 shrink-0" />
									<span>
										{bootState === "checking-server"
											? "Checking local OpenCode server..."
											: "Starting local OpenCode server..."}
									</span>
								</div>
							)}

							{/* Error banner */}
							{!isBooting && (bootState === "error" || lastError) && (
								<div className="flex items-center gap-2 px-4 py-2 bg-destructive/10 border-b border-destructive/20 text-sm text-destructive">
									<AlertCircle className="size-4 shrink-0" />
									<span className="flex-1 truncate">
										{bootState === "error" ? bootError : lastError}
									</span>
									<Button variant="ghost" size="icon-xs" onClick={clearError}>
										<X className="size-3" />
									</Button>
								</div>
							)}

							{/* Chat area */}
							<MessageList />

							{/* Queue list + Prompt input */}
							<div className="shrink-0">
								<div className="max-w-2xl mx-auto">
									{queuedPrompts.length > 0 && (
										<div className="mb-1.5">
											<QueueList
												items={queuedPrompts}
												onRemove={(id) => {
													if (!activeSessionId) return;
													removeFromQueue(activeSessionId, id);
												}}
												onMoveUp={(index) => {
													if (!activeSessionId) return;
													reorderQueue(activeSessionId, index, index - 1);
												}}
												onMoveDown={(index) => {
													if (!activeSessionId) return;
													reorderQueue(activeSessionId, index, index + 1);
												}}
												onMoveToTop={(index) => {
													if (!activeSessionId) return;
													reorderQueue(activeSessionId, index, 0);
												}}
												onMoveToBottom={(index) => {
													if (!activeSessionId) return;
													reorderQueue(
														activeSessionId,
														index,
														queuedPrompts.length - 1,
													);
												}}
												onEdit={(id, newText) => {
													if (!activeSessionId) return;
													updateQueuedPrompt(activeSessionId, id, newText);
												}}
												onSendNow={(id) => {
													if (!activeSessionId) return;
													void sendQueuedNow(activeSessionId, id);
												}}
											/>
										</div>
									)}
									<PromptBox
										autoFocus
										disabled={
											isBooting ||
											!isConnected ||
											isLoadingMessages ||
											(!activeSessionId && !draftSessionDirectory)
										}
										isLoading={isBusy}
										contextPercent={contextPercent}
										onSubmit={(message, images) => {
											sendPrompt(message, images);
										}}
										onStop={() => abortSession()}
									/>
								</div>
							</div>
						</div>

						{/* Right sidebar: task list */}
						<TodoSidebar todos={sessionTodos} />
					</div>
				</RightSidebarProvider>
			</SidebarInset>

			{/* Update-available popup */}
			<UpdateDialog update={updateCheck} />
		</SidebarProvider>
	);
}

export function App() {
	return (
		<OpenCodeProvider>
			<AppContent />
		</OpenCodeProvider>
	);
}
