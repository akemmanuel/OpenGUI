import { AlertCircle, X } from "lucide-react";
import { useEffect, useMemo } from "react";
import { QueueList } from "@/components/QueueList";
import { Button } from "@/components/ui/button";
import { SidebarInset, SidebarProvider } from "@/components/ui/sidebar";
import { Spinner } from "@/components/ui/spinner";
import {
	hasAnyConnection,
	OpenCodeProvider,
	resolveServerDefaultModel,
	useOpenCode,
} from "@/hooks/use-opencode";
import { AppSidebar } from "./components/AppSidebar";
import { MessageList } from "./components/MessageList";
import { PromptBox } from "./components/PromptBox";
import { TitleBar } from "./components/TitleBar";
import "./index.css";

function AppContent() {
	const {
		state,
		sendPrompt,
		abortSession,
		clearError,
		getQueuedPrompts,
		removeFromQueue,
		reorderQueue,
		updateQueuedPrompt,
		sendQueuedNow,
		cycleVariant,
	} = useOpenCode();

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

	const activeSessionId = state.activeSessionId;
	const queuedPrompts = activeSessionId
		? getQueuedPrompts(activeSessionId)
		: [];

	const isConnected = hasAnyConnection(state.connections);
	const isBooting =
		state.bootState === "checking-server" ||
		state.bootState === "starting-server";

	// Compute context usage percentage from the last assistant message's total
	// token count and the model's context window limit.  "Total" includes
	// everything in the context window: system prompt, chat history, tool
	// calls/results, reasoning, cache - i.e. the full window footprint.
	//
	// Resolves the model from the last assistant message (most accurate),
	// then falls back to the UI-selected model, then provider defaults.
	const {
		providers,
		selectedModel,
		providerDefaults,
		messages,
		activeSessionId: ctxActiveSessionId,
	} = state;
	const contextPercent = useMemo<number | null>(() => {
		if (!ctxActiveSessionId) return null;

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
				let total = 0;
				if (t) {
					total =
						typeof t.total === "number" && t.total > 0
							? t.total
							: (t.input ?? 0) +
								(t.output ?? 0) +
								(t.reasoning ?? 0) +
								(t.cache?.read ?? 0) +
								(t.cache?.write ?? 0);
				}

				// If no message-level tokens yet, sum step-finish parts (live during streaming)
				if (total <= 0) {
					const parts = messages[i]?.parts;
					if (parts) {
						for (const part of parts) {
							if (part.type === "step-finish" && "tokens" in part) {
								const st = part.tokens;
								const stepTotal =
									typeof st.total === "number" && st.total > 0
										? st.total
										: (st.input ?? 0) +
											(st.output ?? 0) +
											(st.reasoning ?? 0) +
											(st.cache?.read ?? 0) +
											(st.cache?.write ?? 0);
								total += stepTotal;
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
	}, [
		ctxActiveSessionId,
		messages,
		providers,
		selectedModel,
		providerDefaults,
	]);

	return (
		<SidebarProvider>
			<AppSidebar />
			<SidebarInset>
				<div className="h-screen flex flex-col min-w-0 select-none">
					<TitleBar />

					{/* Startup banner */}
					{isBooting && (
						<div className="flex items-center gap-2 px-4 py-2 border-b border-border text-sm text-muted-foreground bg-muted/30">
							<Spinner className="size-4 shrink-0" />
							<span>
								{state.bootState === "checking-server"
									? "Checking local OpenCode server..."
									: "Starting local OpenCode server..."}
							</span>
						</div>
					)}

					{/* Error banner */}
					{!isBooting && (state.bootState === "error" || state.lastError) && (
						<div className="flex items-center gap-2 px-4 py-2 bg-destructive/10 border-b border-destructive/20 text-sm text-destructive">
							<AlertCircle className="size-4 shrink-0" />
							<span className="flex-1 truncate">
								{state.bootState === "error"
									? state.bootError
									: state.lastError}
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
									state.isLoadingMessages ||
									(!state.activeSessionId && !state.draftSessionDirectory)
								}
								isLoading={state.isBusy}
								contextPercent={contextPercent}
								onSubmit={(message, images) => {
									sendPrompt(message, images);
								}}
								onStop={() => abortSession()}
							/>
						</div>
					</div>
				</div>
			</SidebarInset>
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

export default App;
