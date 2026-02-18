/**
 * Renders the chat message list for the active session.
 * Handles user messages, assistant text, tool calls, and permission requests.
 */

import type {
	FilePart,
	Part,
	QuestionAnswer,
	QuestionInfo,
	ReasoningPart,
	TextPart,
	ToolPart,
} from "@opencode-ai/sdk/v2/client";
import {
	AlertTriangle,
	Check,
	CheckCircle2,
	ChevronRight,
	Circle,
	CircleCheck,
	CircleDot,
	CircleOff,
	FileCode,
	FileEdit,
	FilePlus,
	FolderOpen,
	GitFork,
	Layers,
	MessageCircleQuestion,
	Search,
	ShieldAlert,
	SquareTerminal,
	Timer,
	Undo2,
	Wrench,
	X,
	XCircle,
} from "lucide-react";
import {
	memo,
	useCallback,
	useEffect,
	useLayoutEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import { MarkdownRenderer } from "@/components/MarkdownRenderer";
import { ProviderIcon } from "@/components/provider-icons";
import { Button } from "@/components/ui/button";
import {
	Card,
	CardAction,
	CardContent,
	CardHeader,
	CardTitle,
} from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import { Spinner } from "@/components/ui/spinner";
import {
	getChildSessionToolParts,
	type MessageEntry,
	useOpenCode,
} from "@/hooks/use-opencode";
import { abbreviatePath, cn } from "@/lib/utils";
import logoDark from "../../opengui-dark.svg";
import logoLight from "../../opengui-light.svg";

/** Threshold in px – if the user is within this distance of the bottom we consider them "at bottom". */
const NEAR_BOTTOM_PX = 80;

/** Part types that actually render something visible. */
const RENDERABLE_TYPES = new Set(["text", "reasoning", "tool", "file"]);

/** Format a timestamp into a relative time string like "23 seconds ago", "1 day ago" */
function timeAgo(timestamp: number): string {
	const seconds = Math.floor((Date.now() - timestamp) / 1000);
	if (seconds < 60) return `${seconds} seconds ago`;
	const minutes = Math.floor(seconds / 60);
	if (minutes < 60) return `${minutes} minute${minutes !== 1 ? "s" : ""} ago`;
	const hours = Math.floor(minutes / 60);
	if (hours < 24) return `${hours} hour${hours !== 1 ? "s" : ""} ago`;
	const days = Math.floor(hours / 24);
	return `${days} day${days !== 1 ? "s" : ""} ago`;
}

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

export function MessageList() {
	const {
		state,
		respondPermission,
		replyQuestion,
		rejectQuestion,
		openDirectory,
		connectToProject,
		setDraftTemporary,
		forkFromMessage,
		unrevert,
	} = useOpenCode();
	const {
		messages,
		isBusy,
		isLoadingMessages,
		pendingPermissions,
		pendingQuestions,
		activeSessionId,
		recentProjects,
		sessions,
	} = state;
	const activeSession = useMemo(
		() => sessions.find((s) => s.id === activeSessionId),
		[sessions, activeSessionId],
	);
	const revertMessageID = activeSession?.revert?.messageID;
	const pendingPermission = activeSessionId
		? (pendingPermissions[activeSessionId] ?? null)
		: null;
	const pendingQuestion = activeSessionId
		? (pendingQuestions[activeSessionId] ?? null)
		: null;

	const [homeDir, setHomeDir] = useState("");
	useEffect(() => {
		window.electronAPI?.getHomeDir?.().then((d) => setHomeDir(d ?? ""));
	}, []);
	const [nowMs, setNowMs] = useState(() => Date.now());

	useEffect(() => {
		if (!isBusy) return;
		setNowMs(Date.now());
		const timer = window.setInterval(() => setNowMs(Date.now()), 1000);
		return () => window.clearInterval(timer);
	}, [isBusy]);

	const listRef = useRef<HTMLDivElement>(null);
	const bottomRef = useRef<HTMLDivElement>(null);
	/** Whether the user is currently near the bottom of the scroll container. */
	const isNearBottomRef = useRef(true);
	/** Set to true while we are programmatically scrolling to avoid the onScroll handler unsetting sticky. */
	const isProgrammaticScrollRef = useRef(false);
	/** RAF handle so we batch at most one scroll per frame. */
	const rafRef = useRef<number | null>(null);
	const prevSessionRef = useRef<string | null>(null);
	const sessionJustSwitchedRef = useRef(false);

	// ---- helpers ----

	const checkNearBottom = useCallback(() => {
		const el = listRef.current;
		if (!el) return true;
		return el.scrollHeight - el.scrollTop - el.clientHeight <= NEAR_BOTTOM_PX;
	}, []);

	const scrollToBottom = useCallback((instant: boolean) => {
		if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
		rafRef.current = requestAnimationFrame(() => {
			rafRef.current = null;
			const el = listRef.current;
			if (!el) return;
			isProgrammaticScrollRef.current = true;
			el.scrollTo({
				top: el.scrollHeight,
				behavior: instant ? "auto" : "smooth",
			});
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
		const rendered = messages.filter(hasVisibleContent);
		if (!revertMessageID) return rendered;
		// Hide messages at or after the revert point
		return rendered.filter((m) => m.info.id < revertMessageID);
	}, [messages, revertMessageID]);

	// Count reverted messages for the banner
	const revertedCount = useMemo(() => {
		if (!revertMessageID) return 0;
		return messages.filter(
			(m) => hasVisibleContent(m) && m.info.id >= revertMessageID,
		).length;
	}, [messages, revertMessageID]);

	const turnDurationByAssistantId = useMemo(() => {
		const userStartById = new Map<string, number>();
		const latestAssistantByParent = new Map<string, MessageEntry>();

		for (const entry of visibleMessages) {
			if (entry.info.role === "user") {
				userStartById.set(entry.info.id, entry.info.time.created);
				continue;
			}
			if (entry.info.role !== "assistant") continue;
			const parentId = entry.info.parentID;
			const existing = latestAssistantByParent.get(parentId);
			if (!existing || entry.info.time.created >= existing.info.time.created) {
				latestAssistantByParent.set(parentId, entry);
			}
		}

		const durationByAssistantId = new Map<string, string>();
		for (const [parentId, assistantEntry] of latestAssistantByParent) {
			const start = userStartById.get(parentId);
			if (typeof start !== "number") continue;
			if (assistantEntry.info.role !== "assistant") continue;
			const completedAt = assistantEntry.info.time.completed;
			const end =
				typeof completedAt === "number" ? completedAt : isBusy ? nowMs : null;
			if (typeof end !== "number") continue;
			const duration = end - start;
			if (!Number.isFinite(duration) || duration < 0) continue;
			durationByAssistantId.set(
				assistantEntry.info.id,
				formatDuration(duration),
			);
		}

		return durationByAssistantId;
	}, [visibleMessages, isBusy, nowMs]);

	// ---- session switch: jump to bottom synchronously before paint ----

	useLayoutEffect(() => {
		if (!sessionJustSwitchedRef.current) return;
		const el = listRef.current;
		if (!el || visibleMessages.length === 0) return;
		// Scroll synchronously so the browser never paints the top position.
		isProgrammaticScrollRef.current = true;
		el.scrollTop = el.scrollHeight;
		sessionJustSwitchedRef.current = false;
		requestAnimationFrame(() => {
			isProgrammaticScrollRef.current = false;
		});
	}, [visibleMessages]);

	// ---- streaming / new content: scroll only if sticky ----

	useEffect(() => {
		// visibleMessages is intentionally in the dep array so this effect
		// re-fires on every streaming delta, keeping the view pinned to the
		// bottom while new tokens arrive.
		void visibleMessages;
		if (!isNearBottomRef.current) return;
		// Skip if we already handled this render in the layout effect above.
		if (sessionJustSwitchedRef.current) return;
		// During streaming use instant scroll to avoid competing smooth animations.
		scrollToBottom(isBusy);
	}, [isBusy, visibleMessages, scrollToBottom]);

	if (isLoadingMessages) {
		return (
			<div className="flex-1 flex items-center justify-center">
				<Spinner className="size-6 text-muted-foreground" />
			</div>
		);
	}

	const { draftSessionDirectory } = state;
	const isDraft = !activeSessionId && !!draftSessionDirectory;

	if (
		isDraft ||
		!activeSessionId ||
		(visibleMessages.length === 0 && !isBusy)
	) {
		// Draft mode: show just the logo (empty chat, ready for first message).
		// No-session mode: show logo + recent projects card.
		const showRecentProjects = !isDraft;

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

					{isDraft && draftSessionDirectory && (
						<div className="mt-2 flex items-center gap-1.5 text-muted-foreground">
							<FolderOpen className="size-3.5" />
							<span className="font-mono text-xs">
								{abbreviatePath(draftSessionDirectory, homeDir)}
							</span>
						</div>
					)}

					{isDraft && (
						<button
							type="button"
							onClick={() => setDraftTemporary(!state.draftIsTemporary)}
							className={cn(
								"mt-1 flex items-center gap-1.5 rounded-full px-3 py-1 text-xs font-medium transition-colors",
								state.draftIsTemporary
									? "bg-amber-500/15 text-amber-600 dark:text-amber-400"
									: "bg-muted text-muted-foreground hover:bg-muted/80",
							)}
							title="Temporary chats are deleted when you navigate away"
						>
							<Timer className="size-3" />
							Temporary
						</button>
					)}

					{showRecentProjects && (
						<Card className="w-full max-w-2xl gap-0 border-none shadow-none !bg-transparent">
							<CardHeader className="pb-2">
								<CardTitle className="text-base font-semibold">
									Recent projects
								</CardTitle>
								<CardAction>
									<Button
										variant="outline"
										size="sm"
										onClick={async () => {
											const dir = await openDirectory();
											if (dir) connectToProject(dir);
										}}
									>
										<FolderOpen className="size-4" />
										Open project
									</Button>
								</CardAction>
							</CardHeader>
							<CardContent className="px-0">
								{recentProjects.length === 0 ? (
									<p className="px-6 py-4 text-sm text-muted-foreground">
										No recent projects yet. Connect to a project to get started.
									</p>
								) : (
									recentProjects.map((project, index) => (
										<div key={project.directory}>
											<Button
												variant="ghost"
												className="h-auto w-full justify-between px-6 py-2"
												onClick={() =>
													connectToProject(project.directory, project.serverUrl)
												}
											>
												<span className="truncate pr-4 text-left font-mono text-sm text-foreground">
													{abbreviatePath(project.directory, homeDir)}
												</span>
												<span className="shrink-0 text-sm text-muted-foreground">
													{timeAgo(project.lastConnected)}
												</span>
											</Button>
											{index < recentProjects.length - 1 ? <Separator /> : null}
										</div>
									))
								)}
							</CardContent>
						</Card>
					)}
				</div>
			</div>
		);
	}

	return (
		<div
			ref={listRef}
			onScroll={handleScroll}
			className="flex-1 overflow-auto px-4 py-4"
		>
			<div className="max-w-[640px] mx-auto">
				{activeSessionId && state.temporarySessions.has(activeSessionId) && (
					<div className="mb-3 flex items-center justify-center gap-1.5 rounded-md bg-amber-500/10 px-3 py-1.5 text-xs text-amber-600 dark:text-amber-400">
						<Timer className="size-3" />
						Temporary chat - will be deleted when you leave
					</div>
				)}
				{visibleMessages.map((entry, idx) => {
					const prev = idx > 0 ? (visibleMessages[idx - 1] ?? null) : null;
					const isConsecutive =
						prev !== null && prev.info.role === entry.info.role;
					const spacing = idx === 0 ? "" : isConsecutive ? "mt-1.5" : "mt-4";
					return (
						<div key={entry.info.id} className={spacing}>
							<MessageBubble
								entry={entry}
								turnDurationLabel={turnDurationByAssistantId.get(entry.info.id)}
								onFork={
									entry.info.role === "user"
										? () => forkFromMessage(entry.info.id)
										: undefined
								}
							/>
						</div>
					);
				})}

				{/* Revert marker */}
				{revertMessageID && revertedCount > 0 && (
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
								onClick={() => unrevert()}
								className="hover:text-orange-500 transition-colors cursor-pointer"
							>
								Restore
							</button>
						</div>
						<div className="flex-1 h-px bg-orange-500/30" />
					</div>
				)}

				{/* Permission request */}
				{pendingPermission && (
					<div className="border rounded-lg p-4 bg-amber-500/10 border-amber-500/30 space-y-3">
						<div className="flex items-start gap-2">
							<ShieldAlert className="size-5 text-amber-500 shrink-0 mt-0.5" />
							<div className="space-y-1">
								<p className="text-sm font-medium">
									Permission: {pendingPermission.permission}
								</p>
								{pendingPermission.patterns.length > 0 && (
									<p className="text-xs text-muted-foreground">
										{pendingPermission.patterns.join(", ")}
									</p>
								)}
							</div>
						</div>
						<div className="flex gap-2">
							<Button
								size="sm"
								variant="default"
								onClick={() => respondPermission("once")}
							>
								Allow once
							</Button>
							<Button
								size="sm"
								variant="secondary"
								onClick={() => respondPermission("always")}
							>
								Always allow
							</Button>
							<Button
								size="sm"
								variant="destructive"
								onClick={() => respondPermission("reject")}
							>
								Reject
							</Button>
						</div>
					</div>
				)}

				{/* Question request */}
				{pendingQuestion && (
					<QuestionPanel
						questions={pendingQuestion.questions}
						onSubmit={(answers) => replyQuestion(answers)}
						onDismiss={() => rejectQuestion()}
					/>
				)}

				<div ref={bottomRef} />
			</div>
		</div>
	);
}

// ---------------------------------------------------------------------------
// Question panel
// ---------------------------------------------------------------------------

function QuestionPanel({
	questions,
	onSubmit,
	onDismiss,
}: {
	questions: QuestionInfo[];
	onSubmit: (answers: QuestionAnswer[]) => void;
	onDismiss: () => void;
}) {
	// Each question gets an array of selected labels
	const [selections, setSelections] = useState<string[][]>(() =>
		questions.map(() => []),
	);
	// Custom text inputs per question (when custom answers are allowed)
	const [customTexts, setCustomTexts] = useState<string[]>(() =>
		questions.map(() => ""),
	);

	const toggleOption = useCallback(
		(qIdx: number, label: string, multiple: boolean) => {
			setSelections((prev) => {
				const next = [...prev];
				const current = next[qIdx] ?? [];
				if (multiple) {
					next[qIdx] = current.includes(label)
						? current.filter((l) => l !== label)
						: [...current, label];
				} else {
					next[qIdx] = current.includes(label) ? [] : [label];
				}
				return next;
			});
		},
		[],
	);

	const handleCustomTextChange = useCallback((qIdx: number, text: string) => {
		setCustomTexts((prev) => {
			const next = [...prev];
			next[qIdx] = text;
			return next;
		});
	}, []);

	const handleSubmit = useCallback(() => {
		const answers: QuestionAnswer[] = questions.map((_q, i) => {
			const selected = selections[i] ?? [];
			const custom = (customTexts[i] ?? "").trim();
			if (custom) {
				return [...selected, custom];
			}
			return selected;
		});
		onSubmit(answers);
	}, [questions, selections, customTexts, onSubmit]);

	const hasAnyAnswer =
		selections.some((s) => s.length > 0) ||
		customTexts.some((t) => t.trim().length > 0);

	return (
		<div className="border rounded-lg p-4 bg-primary/5 border-primary/20 space-y-4">
			<div className="flex items-start gap-2">
				<MessageCircleQuestion className="size-5 text-primary shrink-0 mt-0.5" />
				<span className="text-sm font-medium">
					The assistant has a question
				</span>
			</div>

			{questions.map((q, qIdx) => {
				const allowCustom = q.custom !== false; // defaults to true
				return (
					<div key={`q-${q.header}-${qIdx}`} className="space-y-2">
						<div className="space-y-0.5">
							<p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
								{q.header}
							</p>
							<p className="text-sm">{q.question}</p>
						</div>

						<div className="flex flex-wrap gap-1.5">
							{q.options.map((opt) => {
								const isSelected = (selections[qIdx] ?? []).includes(opt.label);
								return (
									<button
										key={opt.label}
										type="button"
										title={opt.description}
										onClick={() =>
											toggleOption(qIdx, opt.label, q.multiple ?? false)
										}
										className={cn(
											"inline-flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-sm transition-colors",
											isSelected
												? "bg-primary text-primary-foreground border-primary"
												: "bg-muted/40 border-border hover:bg-muted text-foreground",
										)}
									>
										{isSelected && <Check className="size-3" />}
										{opt.label}
									</button>
								);
							})}
						</div>

						{allowCustom && (
							<input
								type="text"
								placeholder="Type a custom answer..."
								value={customTexts[qIdx] ?? ""}
								onChange={(e) => handleCustomTextChange(qIdx, e.target.value)}
								onKeyDown={(e) => {
									if (e.key === "Enter" && hasAnyAnswer) {
										e.preventDefault();
										handleSubmit();
									}
								}}
								className="w-full rounded-md border border-border bg-background px-3 py-1.5 text-sm placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring"
							/>
						)}
					</div>
				);
			})}

			<div className="flex gap-2 pt-1">
				<Button
					size="sm"
					variant="default"
					disabled={!hasAnyAnswer}
					onClick={handleSubmit}
				>
					Submit
				</Button>
				<Button size="sm" variant="ghost" onClick={onDismiss}>
					<X className="size-3.5 mr-1" />
					Dismiss
				</Button>
			</div>
		</div>
	);
}

// ---------------------------------------------------------------------------
// Message bubble
// ---------------------------------------------------------------------------

/** Max characters before a user message is collapsed with "Show more". */
const USER_MSG_COLLAPSE_CHARS = 500;

const MessageBubble = memo(function MessageBubble({
	entry,
	turnDurationLabel,
	onFork,
}: {
	entry: MessageEntry;
	turnDurationLabel?: string;
	onFork?: () => void;
}) {
	const { info, parts } = entry;
	const isUser = info.role === "user";
	const [expanded, setExpanded] = useState(false);
	const isSummary =
		info.role === "assistant" && "summary" in info && info.summary === true;

	// Check if user message text exceeds the collapse threshold
	const userTextLength = isUser
		? parts.reduce(
				(sum, p) => sum + (p.type === "text" ? (p.text?.length ?? 0) : 0),
				0,
			)
		: 0;
	const shouldCollapse = isUser && userTextLength > USER_MSG_COLLAPSE_CHARS;

	return (
		<div className={isUser ? "flex justify-end" : ""}>
			{isSummary && (
				<div className="flex items-center gap-2 mb-2 select-none">
					<div className="flex-1 h-px bg-amber-500/30" />
					<div className="flex items-center gap-1.5 text-[11px] text-amber-500/80 font-mono">
						<Layers className="size-3" />
						<span>Context compacted</span>
					</div>
					<div className="flex-1 h-px bg-amber-500/30" />
				</div>
			)}
			<div
				className={cn(
					"min-w-0 group relative",
					isUser
						? "bg-foreground/10 rounded-2xl px-4 py-2 max-w-[85%]"
						: "flex-1",
				)}
			>
				{isUser && onFork && (
					<button
						type="button"
						onClick={onFork}
						title="Fork from this message"
						className="absolute -left-8 top-1/2 -translate-y-1/2 opacity-0 group-hover:opacity-100 transition-opacity p-1 rounded hover:bg-foreground/10 text-muted-foreground hover:text-foreground cursor-pointer"
					>
						<GitFork className="size-3.5" />
					</button>
				)}
				{parts.length > 0 && (
					<div className={cn(shouldCollapse && !expanded && "relative")}>
						<div
							className={cn(
								shouldCollapse && !expanded && "max-h-[8lh] overflow-hidden",
							)}
						>
							{parts.map((part) => (
								<PartView key={part.id} part={part} isUser={isUser} />
							))}
						</div>
						{shouldCollapse && !expanded && (
							<div className="absolute bottom-0 left-0 right-0 h-16 bg-gradient-to-t to-transparent rounded-b-2xl pointer-events-none" />
						)}
						{shouldCollapse && (
							<button
								type="button"
								onClick={() => setExpanded(!expanded)}
								className="text-xs text-muted-foreground hover:text-foreground mt-1 cursor-pointer"
							>
								{expanded ? "Show less" : "Show more"}
							</button>
						)}
					</div>
				)}
				{info.role === "assistant" && info.error && (
					<div className="text-xs text-destructive flex items-center gap-1 mt-1">
						<AlertTriangle className="size-3" />
						{"data" in info.error &&
						info.error.data &&
						typeof info.error.data === "object" &&
						"message" in info.error.data
							? String(info.error.data.message)
							: info.error.name}
					</div>
				)}
				{info.role === "assistant" && turnDurationLabel && (
					<div className="mt-1 flex items-center gap-1.5 text-[11px] text-muted-foreground tabular-nums">
						{turnDurationLabel}
						{"providerID" in info && info.providerID && (
							<ProviderIcon
								provider={info.providerID}
								className="size-3 shrink-0 opacity-60"
							/>
						)}
						{"modelID" in info && info.modelID && (
							<span className="opacity-60">{info.modelID}</span>
						)}
					</div>
				)}
			</div>
		</div>
	);
});

// ---------------------------------------------------------------------------
// Part renderers
// ---------------------------------------------------------------------------

function TextPartView({ part, isUser }: { part: TextPart; isUser?: boolean }) {
	if (!part.text) return null;

	if (isUser) {
		return (
			<div className="mb-1 text-sm whitespace-pre-wrap break-words select-text">
				{part.text}
			</div>
		);
	}

	return (
		<div className="mb-1">
			<MarkdownRenderer content={part.text} />
		</div>
	);
}

function FilePartView({ part }: { part: FilePart }) {
	const isImage = (part.mime ?? "").toLowerCase().startsWith("image/");
	const src = normalizeAttachmentImageSrc(part.url);

	if (isImage) {
		return (
			<div className="mb-1">
				<img
					src={src}
					alt={part.filename ?? "Image"}
					className="max-h-64 max-w-full rounded-lg object-contain"
				/>
				{part.filename && (
					<p className="text-xs text-muted-foreground mt-1 truncate">
						{part.filename}
					</p>
				)}
			</div>
		);
	}

	return (
		<div className="mb-1 text-sm text-muted-foreground italic">
			{part.filename ?? "File attachment"}
		</div>
	);
}

function PartView({ part, isUser }: { part: Part; isUser?: boolean }) {
	switch (part.type) {
		case "text":
			return <TextPartView part={part} isUser={isUser} />;
		case "file":
			return <FilePartView part={part} />;
		case "reasoning":
			return <ReasoningPartView part={part} />;
		case "tool":
			return <ToolPartView part={part} />;
		case "step-start":
		case "step-finish":
		case "snapshot":
		case "patch":
		case "compaction":
		case "retry":
			return null;
		default:
			return null;
	}
}

const TIMELINE_ROW_BASE = "flex min-w-0 items-center gap-1.5";
const TIMELINE_BUTTON_RESET =
	"m-0 appearance-none border-0 bg-transparent p-0 text-left text-inherit";

function ReasoningPartView({ part }: { part: ReasoningPart }) {
	const [expanded, setExpanded] = useState(false);

	if (!part.text) return null;

	const durationMs =
		part.time.end && part.time.start ? part.time.end - part.time.start : null;
	const durationLabel = durationMs !== null ? formatDuration(durationMs) : null;

	return (
		<div className="mb-1 text-xs font-mono text-muted-foreground overflow-hidden">
			<details
				open={expanded}
				onToggle={(e) => setExpanded(e.currentTarget.open)}
				className="m-0"
			>
				<summary
					className={cn(
						TIMELINE_ROW_BASE,
						TIMELINE_BUTTON_RESET,
						"list-none hover:text-foreground transition-colors cursor-pointer [&::-webkit-details-marker]:hidden",
					)}
				>
					<span className="w-3 shrink-0 flex items-center justify-center">
						<ChevronRight
							className={cn(
								"size-3 transition-transform duration-150",
								expanded && "rotate-90",
							)}
						/>
					</span>
					<span className="font-medium">Thinking</span>
					{durationLabel && <span className="opacity-60">{durationLabel}</span>}
				</summary>
			</details>
			{expanded && (
				<pre className="pl-5 pt-1 text-xs text-muted-foreground whitespace-pre-wrap break-words leading-relaxed max-h-96 overflow-auto">
					{part.text}
				</pre>
			)}
		</div>
	);
}

// ---------------------------------------------------------------------------
// Todo list renderer (for todowrite tool calls)
// ---------------------------------------------------------------------------

interface TodoItem {
	content: string;
	status: string;
	priority: string;
}

/** Try to extract a todo array from a todowrite tool part. */
function extractTodos(state: ToolPart["state"]): TodoItem[] | null {
	try {
		// Prefer input.todos (always present once the tool is called)
		if ("input" in state && state.input) {
			const raw = state.input.todos;
			if (Array.isArray(raw) && raw.length > 0) {
				return raw.filter(
					(t): t is TodoItem =>
						typeof t === "object" &&
						t !== null &&
						typeof t.content === "string" &&
						typeof t.status === "string",
				);
			}
		}
	} catch {
		/* ignore */
	}
	return null;
}

const todoStatusConfig: Record<string, { icon: typeof Circle; color: string }> =
	{
		pending: { icon: Circle, color: "text-muted-foreground" },
		in_progress: { icon: CircleDot, color: "text-blue-400" },
		completed: { icon: CircleCheck, color: "text-emerald-500" },
		cancelled: { icon: CircleOff, color: "text-red-400 opacity-60" },
	};

function TodoListView({ todos }: { todos: TodoItem[] }) {
	return (
		<div className="border-t border-border/40 pt-1.5 mt-1.5 space-y-0.5">
			{todos.map((todo, i) => {
				const cfg = todoStatusConfig[todo.status] ?? {
					icon: Circle,
					color: "text-muted-foreground",
				};
				const Icon = cfg.icon;
				const isCancelled = todo.status === "cancelled";
				return (
					<div
						key={`todo-${todo.content}-${i}`}
						className="flex items-center gap-1.5 min-h-5"
					>
						<Icon className={cn("size-3 shrink-0", cfg.color)} />
						<span
							className={cn(
								"flex-1 text-[11px] leading-tight",
								isCancelled && "line-through opacity-50",
								todo.status === "completed" && "text-muted-foreground",
							)}
						>
							{todo.content}
						</span>
					</div>
				);
			})}
		</div>
	);
}

// ---------------------------------------------------------------------------
// Task tool renderer (collapsible details like Thinking)
// ---------------------------------------------------------------------------

interface TaskInfo {
	description: string;
	subagentType?: string;
	/** Child session ID from metadata (for live step tracking). */
	childSessionId?: string;
	/** Subagent tool calls extracted from metadata (if available). */
	toolCalls: Array<{ tool: string; title?: string; status?: string }>;
	/** Final markdown output from the subagent. */
	output: string;
}

interface ImageAttachmentInfo {
	url: string;
	src: string;
	mime: string;
	filename?: string;
}

function normalizeAttachmentImageSrc(url: string): string {
	const trimmed = url.trim();
	if (!trimmed) return trimmed;
	if (/^(data:|blob:|https?:|file:)/i.test(trimmed)) return trimmed;
	if (/^[a-zA-Z]:[\\/]/.test(trimmed)) {
		return `file:///${trimmed.replace(/\\/g, "/")}`;
	}
	if (trimmed.startsWith("/")) return `file://${trimmed}`;
	return trimmed;
}

function extractImageAttachments(
	state: ToolPart["state"],
): ImageAttachmentInfo[] {
	if (state.status !== "completed") return [];
	if (!Array.isArray(state.attachments) || state.attachments.length === 0) {
		return [];
	}

	return state.attachments
		.filter((att) => {
			const mime = (att.mime ?? "").toLowerCase();
			return (
				mime === "image/png" || mime === "image/jpeg" || mime === "image/jpg"
			);
		})
		.map((att) => ({
			url: att.url,
			src: normalizeAttachmentImageSrc(att.url),
			mime: att.mime,
			filename: att.filename,
		}));
}

function formatDuration(ms: number): string {
	const safeMs = Math.max(0, Math.round(ms));
	if (safeMs < 1000) return `${(safeMs / 1000).toFixed(1)}s`;
	const totalSeconds = Math.round(safeMs / 1000);
	if (totalSeconds < 60) {
		if (totalSeconds < 10) return `${(safeMs / 1000).toFixed(1)}s`;
		return `${totalSeconds}s`;
	}
	const minutes = Math.floor(totalSeconds / 60);
	const seconds = totalSeconds % 60;
	if (minutes < 60) {
		return `${minutes}m ${String(seconds).padStart(2, "0")}s`;
	}
	const hours = Math.floor(minutes / 60);
	const remMinutes = minutes % 60;
	return `${hours}h ${String(remMinutes).padStart(2, "0")}m`;
}

function getTaskDurationLabel(state: ToolPart["state"]): string | null {
	if (
		(state.status === "completed" || state.status === "error") &&
		"time" in state &&
		state.time &&
		typeof state.time.start === "number" &&
		typeof state.time.end === "number"
	) {
		const duration = state.time.end - state.time.start;
		if (Number.isFinite(duration) && duration >= 0) {
			return formatDuration(duration);
		}
	}
	return null;
}

/** Extract execution info from a task tool call (input for header, output/metadata for content). */
function extractTaskInfo(state: ToolPart["state"]): TaskInfo | null {
	const input = "input" in state ? state.input : null;
	const description =
		input && typeof input.description === "string"
			? input.description.trim()
			: "";
	const subagentType =
		input && typeof input.subagent_type === "string"
			? input.subagent_type.trim()
			: undefined;

	// Extract child session ID and tool calls from metadata if present
	let childSessionId: string | undefined;
	const toolCalls: TaskInfo["toolCalls"] = [];
	if (
		"metadata" in state &&
		state.metadata &&
		typeof state.metadata === "object"
	) {
		const meta = state.metadata as Record<string, unknown>;
		if (typeof meta.sessionId === "string") {
			childSessionId = meta.sessionId;
		}
		// Try common metadata shapes: toolCalls, tools, calls
		const rawCalls = meta.toolCalls ?? meta.tools ?? meta.calls;
		if (Array.isArray(rawCalls)) {
			for (const tc of rawCalls) {
				if (
					typeof tc === "object" &&
					tc !== null &&
					"tool" in tc &&
					typeof tc.tool === "string"
				) {
					toolCalls.push({
						tool: tc.tool,
						title: typeof tc.title === "string" ? tc.title : undefined,
						status: typeof tc.status === "string" ? tc.status : undefined,
					});
				}
			}
		}
	}

	// Extract output text
	let output = "";
	if ("output" in state && typeof state.output === "string") {
		output = state.output.trim();
	}

	if (!description && !output && toolCalls.length === 0) return null;

	return { description, subagentType, childSessionId, toolCalls, output };
}

// ---------------------------------------------------------------------------
// Edit diff helper
// ---------------------------------------------------------------------------

type DiffLine = { type: "same" | "add" | "remove"; text: string };

/** Compute a simple line-level diff between two strings using LCS. */
function computeLineDiff(
	oldStr: string,
	newStr: string,
): {
	added: number;
	removed: number;
	lines: { type: "same" | "add" | "remove"; text: string }[];
} {
	const oldLines = oldStr.split("\n");
	const newLines = newStr.split("\n");

	// LCS table for line-level diff
	const m = oldLines.length;
	const n = newLines.length;
	const dp: number[][] = Array.from({ length: m + 1 }, () =>
		new Array<number>(n + 1).fill(0),
	);
	for (let i = 1; i <= m; i++) {
		for (let j = 1; j <= n; j++) {
			const row = dp[i];
			const prevRow = dp[i - 1];
			if (row && prevRow) {
				row[j] =
					oldLines[i - 1] === newLines[j - 1]
						? (prevRow[j - 1] ?? 0) + 1
						: Math.max(prevRow[j] ?? 0, row[j - 1] ?? 0);
			}
		}
	}

	// Backtrack to produce diff lines
	const lines: DiffLine[] = [];
	let i = m;
	let j = n;
	while (i > 0 || j > 0) {
		if (i > 0 && j > 0 && oldLines[i - 1] === newLines[j - 1]) {
			lines.push({ type: "same", text: oldLines[i - 1] ?? "" });
			i--;
			j--;
		} else if (
			j > 0 &&
			(i === 0 || (dp[i]?.[j - 1] ?? 0) >= (dp[i - 1]?.[j] ?? 0))
		) {
			lines.push({ type: "add", text: newLines[j - 1] ?? "" });
			j--;
		} else {
			lines.push({ type: "remove", text: oldLines[i - 1] ?? "" });
			i--;
		}
	}
	lines.reverse();

	let added = 0;
	let removed = 0;
	for (const l of lines) {
		if (l.type === "add") added++;
		if (l.type === "remove") removed++;
	}

	return { added, removed, lines };
}

/** Compute added/removed line counts from oldString/newString in an edit tool input. */
function computeEditDiff(input: Record<string, unknown>): {
	added: number;
	removed: number;
	lines: { type: "same" | "add" | "remove"; text: string }[];
} | null {
	const oldStr = input.oldString;
	const newStr = input.newString;
	if (typeof oldStr !== "string" || typeof newStr !== "string") return null;
	return computeLineDiff(oldStr, newStr);
}

/** Compute diff for write tools (entire file is new content). */
function computeWriteDiff(input: Record<string, unknown>): {
	added: number;
	removed: number;
	lines: { type: "same" | "add" | "remove"; text: string }[];
} | null {
	const content = input.content;
	if (typeof content !== "string") return null;
	const added = content.split("\n").length;
	return {
		added,
		removed: 0,
		lines: content.split("\n").map((t) => ({ type: "add" as const, text: t })),
	};
}

/** Inline diff viewer component. */
function DiffView({
	lines,
}: {
	lines: { type: "same" | "add" | "remove"; text: string }[];
}) {
	// Collapse runs of unchanged lines in the middle, keep 2 context lines around changes
	const CONTEXT = 2;
	const changeIndices = new Set<number>();
	for (let i = 0; i < lines.length; i++) {
		if (lines[i]?.type !== "same") {
			for (
				let c = Math.max(0, i - CONTEXT);
				c <= Math.min(lines.length - 1, i + CONTEXT);
				c++
			) {
				changeIndices.add(c);
			}
		}
	}

	const elements: React.ReactNode[] = [];
	let skipping = false;
	for (let i = 0; i < lines.length; i++) {
		if (!changeIndices.has(i)) {
			if (!skipping) {
				skipping = true;
				elements.push(
					<div
						key={`skip-${i}`}
						className="text-muted-foreground/40 px-2 select-none"
					>
						...
					</div>,
				);
			}
			continue;
		}
		skipping = false;
		const line = lines[i];
		if (!line) continue;
		const bg =
			line.type === "add"
				? "bg-emerald-500/10 text-emerald-400"
				: line.type === "remove"
					? "bg-red-500/10 text-red-400"
					: "text-muted-foreground/60";
		const prefix =
			line.type === "add" ? "+" : line.type === "remove" ? "-" : " ";
		elements.push(
			<div key={i} className={cn("px-2 whitespace-pre-wrap break-all", bg)}>
				<span className="select-none inline-block w-4 shrink-0 opacity-60">
					{prefix}
				</span>
				{line.text || "\u00A0"}
			</div>,
		);
	}

	return (
		<div className="mt-1 ml-5 rounded border border-border/40 bg-background/60 overflow-auto max-h-64 text-[11px] font-mono leading-relaxed">
			{elements}
		</div>
	);
}

// ---------------------------------------------------------------------------
// Child tool part display helpers (for live subagent step tracking)
// ---------------------------------------------------------------------------

/** Get a compact display label and icon for a tool part from a child session. */
function getToolDisplayInfo(
	tool: string,
	toolState: ToolPart["state"],
): { icon: typeof Wrench; label: string; subtitle: string } {
	const input =
		"input" in toolState ? (toolState.input as Record<string, unknown>) : null;
	const title =
		"title" in toolState && typeof toolState.title === "string"
			? toolState.title
			: null;

	const lower = tool.toLowerCase();

	if (lower === "bash" || lower === "shell" || lower === "execute_command") {
		const cmd = input?.command;
		const cmdStr = typeof cmd === "string" ? `$ ${cmd}` : (title ?? "");
		return { icon: SquareTerminal, label: "Bash", subtitle: cmdStr };
	}
	if (lower === "read") {
		const path = input?.filePath ?? input?.path;
		return {
			icon: FileCode,
			label: "Read",
			subtitle: typeof path === "string" ? path : (title ?? ""),
		};
	}
	if (lower === "edit") {
		const path = input?.filePath ?? input?.path;
		return {
			icon: FileEdit,
			label: "Edit",
			subtitle: typeof path === "string" ? path : (title ?? ""),
		};
	}
	if (lower === "write") {
		const path = input?.filePath ?? input?.path;
		return {
			icon: FilePlus,
			label: "Write",
			subtitle: typeof path === "string" ? path : (title ?? ""),
		};
	}
	if (lower === "grep" || lower === "mcp_grep") {
		const pattern = input?.pattern;
		return {
			icon: Search,
			label: "Grep",
			subtitle: typeof pattern === "string" ? pattern : (title ?? ""),
		};
	}
	if (lower === "glob" || lower === "mcp_glob") {
		const pattern = input?.pattern;
		return {
			icon: Search,
			label: "Glob",
			subtitle: typeof pattern === "string" ? pattern : (title ?? ""),
		};
	}
	if (lower === "task") {
		const desc = input?.description;
		return {
			icon: Layers,
			label: "Task",
			subtitle: typeof desc === "string" ? desc : (title ?? ""),
		};
	}
	if (lower === "todowrite") {
		return {
			icon: CircleCheck,
			label: "TodoWrite",
			subtitle: title ?? "",
		};
	}
	// Fallback for any other tool
	return {
		icon: Wrench,
		label: tool,
		subtitle: title ?? "",
	};
}

/** Renders the list of tool parts from a child (subagent) session. */
function ChildToolPartsList({ childSessionId }: { childSessionId: string }) {
	const { state } = useOpenCode();
	const childParts = useMemo(
		() => getChildSessionToolParts(state.childSessions, childSessionId),
		[state.childSessions, childSessionId],
	);

	if (childParts.length === 0) return null;

	return (
		<div className="space-y-0.5">
			{childParts.map((part) => {
				if (part.type !== "tool") return null;
				const toolPart = part as ToolPart;
				const info = getToolDisplayInfo(toolPart.tool, toolPart.state);
				const Icon = info.icon;
				const isRunning =
					toolPart.state.status === "running" ||
					toolPart.state.status === "pending";
				const isError = toolPart.state.status === "error";
				const isCompleted = toolPart.state.status === "completed";
				return (
					<div
						key={part.id}
						className="flex items-center gap-1.5 text-xs font-mono min-h-5"
					>
						<span className="w-3 shrink-0 flex items-center justify-center">
							{isRunning ? (
								<Spinner className="size-2.5" />
							) : isCompleted ? (
								<Check className="size-2.5 text-emerald-500" />
							) : isError ? (
								<X className="size-2.5 text-destructive" />
							) : (
								<Icon className="size-2.5 text-muted-foreground" />
							)}
						</span>
						<span className="text-muted-foreground shrink-0">{info.label}</span>
						{info.subtitle && (
							<span
								className="text-muted-foreground/60 truncate"
								title={info.subtitle}
							>
								{info.subtitle}
							</span>
						)}
					</div>
				);
			})}
		</div>
	);
}

function ToolPartView({ part }: { part: ToolPart }) {
	const { state } = part;
	const [expanded, setExpanded] = useState(false);
	const autoExpandedRef = useRef(false);
	const toolLower = part.tool.toLowerCase();
	const isBash =
		toolLower === "bash" ||
		toolLower === "shell" ||
		toolLower === "execute_command";
	const isGlob = toolLower === "glob";
	const isEdit = toolLower === "edit";
	const isWrite = toolLower === "write";
	const isTodoWrite = toolLower === "todowrite";
	const isTask = toolLower === "task";
	const isGrep = toolLower === "grep" || toolLower === "mcp_grep";
	const diff =
		isEdit && "input" in state
			? computeEditDiff(state.input)
			: isWrite && "input" in state
				? computeWriteDiff(state.input)
				: null;
	const todos = isTodoWrite ? extractTodos(state) : null;
	const taskInfo = isTask ? extractTaskInfo(state) : null;
	const taskDurationLabel = isTask ? getTaskDurationLabel(state) : null;
	const imageAttachments = extractImageAttachments(state);

	// Auto-expand running tasks with a child session ID so steps are visible
	useEffect(() => {
		if (
			isTask &&
			taskInfo?.childSessionId &&
			(state.status === "running" || state.status === "pending") &&
			!autoExpandedRef.current
		) {
			setExpanded(true);
			autoExpandedRef.current = true;
		}
	}, [isTask, taskInfo?.childSessionId, state.status]);
	const bashCommand =
		isBash && "input" in state
			? typeof state.input.command === "string"
				? state.input.command
				: null
			: null;
	const globPattern =
		isGlob && "input" in state
			? typeof state.input.pattern === "string"
				? state.input.pattern
				: null
			: null;
	const grepPattern =
		isGrep && "input" in state
			? typeof state.input.pattern === "string"
				? state.input.pattern
				: null
			: null;
	// Inline context label (filename, command, pattern, or title)
	const contextLabel = bashCommand
		? `$ ${bashCommand}`
		: grepPattern
			? grepPattern
			: globPattern
				? globPattern
				: state.status === "completed" && state.title
					? state.title
					: null;

	// Output text for completed tools (used for expandable output)
	const outputText =
		state.status === "completed" && "output" in state
			? state.output?.trim() || null
			: null;

	const grepMatchCount =
		isGrep && outputText
			? (() => {
					const m = outputText?.match(/^Found (\d+) match/);
					return m?.[1] ? Number.parseInt(m[1], 10) : null;
				})()
			: null;

	// Tool is expandable if it has output text and is completed, or has a diff
	const hasDiffView = diff && diff.lines.length > 0;
	const isExpandable =
		((isBash || isGrep) && outputText) || hasDiffView || (isTask && taskInfo);

	const hasExpandedContent =
		(todos && todos.length > 0) || imageAttachments.length > 0;

	return (
		<div className="mb-1 text-xs font-mono text-muted-foreground overflow-hidden">
			{/* Slim single-line header */}
			{isExpandable ? (
				<details
					open={expanded}
					onToggle={(e) => setExpanded(e.currentTarget.open)}
					className="m-0"
				>
					<summary
						className={cn(
							TIMELINE_ROW_BASE,
							TIMELINE_BUTTON_RESET,
							"list-none hover:text-foreground cursor-pointer transition-colors [&::-webkit-details-marker]:hidden",
						)}
					>
						<span className="w-3 shrink-0 flex items-center justify-center">
							<ChevronRight
								className={cn(
									"size-3 transition-transform duration-150",
									expanded && "rotate-90",
								)}
							/>
						</span>
						<span className="font-medium text-foreground/70">{part.tool}</span>
						{contextLabel && (
							<>
								<span className="text-muted-foreground/40">·</span>
								<span className="truncate" title={contextLabel}>
									{contextLabel}
								</span>
							</>
						)}
						{isTask && taskInfo && (
							<>
								<span className="text-muted-foreground/40">·</span>
								<span className="truncate">
									{taskInfo.description || "Task"}
								</span>
								{taskInfo.subagentType && (
									<span className="opacity-60 shrink-0">
										({taskInfo.subagentType})
									</span>
								)}
							</>
						)}
						{grepMatchCount != null && (
							<span className="text-[11px] text-blue-400 ml-auto whitespace-nowrap">
								{grepMatchCount} {grepMatchCount === 1 ? "match" : "matches"}
							</span>
						)}
						{diff && (
							<span className="flex items-center gap-1 ml-auto whitespace-nowrap text-[11px]">
								<span className="text-emerald-500">+{diff.added}</span>
								<span className="text-red-400">-{diff.removed}</span>
							</span>
						)}
						{isTask && taskDurationLabel && (
							<span className="ml-auto opacity-70 tabular-nums text-[11px] whitespace-nowrap">
								{taskDurationLabel}
							</span>
						)}
						{isTask &&
							(state.status === "running" || state.status === "pending") && (
								<Spinner className="size-3 ml-auto shrink-0" />
							)}
					</summary>
				</details>
			) : (
				<div className={cn(TIMELINE_ROW_BASE, "cursor-default")}>
					<span className="w-3 shrink-0 flex items-center justify-center">
						<ToolStatusIcon status={state.status} />
					</span>
					<span className="font-medium text-foreground/70">{part.tool}</span>
					{contextLabel && (
						<>
							<span className="text-muted-foreground/40">·</span>
							<span className="truncate" title={contextLabel}>
								{contextLabel}
							</span>
						</>
					)}
					{grepMatchCount != null && (
						<span className="text-[11px] text-blue-400 ml-auto whitespace-nowrap">
							{grepMatchCount} {grepMatchCount === 1 ? "match" : "matches"}
						</span>
					)}
					{diff && (
						<span className="flex items-center gap-1 ml-auto whitespace-nowrap text-[11px]">
							<span className="text-emerald-500">+{diff.added}</span>
							<span className="text-red-400">-{diff.removed}</span>
						</span>
					)}
				</div>
			)}
			{/* Expanded bash output */}
			{isExpandable && expanded && !hasDiffView && !isTask && outputText && (
				<pre className="pl-7 pt-1 text-xs text-muted-foreground whitespace-pre-wrap break-words leading-relaxed max-h-64 overflow-auto">
					{outputText}
				</pre>
			)}
			{/* Expanded diff view for edit/write tools */}
			{hasDiffView && expanded && <DiffView lines={diff.lines} />}
			{/* Expanded task content */}
			{isTask && expanded && taskInfo && (
				<div className="pl-7 pt-1 pb-1 space-y-2 max-h-96 overflow-auto">
					{/* Live child session tool parts (preferred over static metadata) */}
					{taskInfo.childSessionId ? (
						<ChildToolPartsList childSessionId={taskInfo.childSessionId} />
					) : (
						taskInfo.toolCalls.length > 0 && (
							<div className="space-y-0.5">
								{taskInfo.toolCalls.map((tc, i) => (
									<div
										key={`${tc.tool}-${i}`}
										className="flex items-center gap-1.5 text-xs font-mono"
									>
										<Wrench className="size-2.5 text-muted-foreground shrink-0" />
										<span className="text-muted-foreground">{tc.tool}</span>
										{tc.title && (
											<span className="text-muted-foreground/70 truncate">
												{tc.title}
											</span>
										)}
										{tc.status === "completed" && (
											<CheckCircle2 className="size-2.5 text-emerald-500 ml-auto shrink-0" />
										)}
										{tc.status === "error" && (
											<XCircle className="size-2.5 text-destructive ml-auto shrink-0" />
										)}
									</div>
								))}
							</div>
						)
					)}
					{taskInfo.output && (
						<div className="text-sm">
							<MarkdownRenderer content={taskInfo.output} />
						</div>
					)}
				</div>
			)}
			{/* Error on a second line */}
			{state.status === "error" && state.error && (
				<div className="text-destructive pl-5 truncate" title={state.error}>
					{state.error}
				</div>
			)}
			{/* Expanded content for special tools */}
			{hasExpandedContent && (
				<div className="pl-5 mt-0.5 space-y-1">
					{imageAttachments.length > 0 && (
						<div
							className={cn(
								"grid gap-2 pt-1",
								imageAttachments.length === 1 ? "grid-cols-1" : "grid-cols-2",
							)}
						>
							{imageAttachments.map((image, idx) => (
								<div
									key={`${image.url}-${idx}`}
									className="overflow-hidden rounded-md border border-border/60 bg-background/60"
								>
									<img
										src={image.src}
										alt={image.filename ?? `Image attachment ${idx + 1}`}
										loading="lazy"
										className="w-full max-h-52 object-contain bg-black/20"
									/>
									{image.filename && (
										<div
											className="px-2 py-1 text-[10px] text-muted-foreground truncate"
											title={image.filename}
										>
											{image.filename}
										</div>
									)}
								</div>
							))}
						</div>
					)}
					{todos && todos.length > 0 && <TodoListView todos={todos} />}
				</div>
			)}
		</div>
	);
}

function ToolStatusIcon({ status }: { status: string }) {
	switch (status) {
		case "running":
		case "pending":
			return <Spinner className="size-3 shrink-0" />;
		case "completed":
			return <Check className="size-3 shrink-0" />;
		case "error":
			return <X className="size-3 shrink-0" />;
		default:
			return <span className="size-3 shrink-0" />;
	}
}
