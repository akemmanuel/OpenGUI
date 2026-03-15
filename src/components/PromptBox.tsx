import type { Command } from "@opencode-ai/sdk/v2/client";
import {
	ArrowUp,
	BookOpen,
	Check,
	GitBranch,
	ListEnd,
	Loader2,
	Mic,
	Paperclip,
	Plus,
	Square,
	Wrench,
	X,
	Zap,
} from "lucide-react";
import * as React from "react";
import { AgentSelector } from "@/components/AgentSelector";
import { FileMentionPopover } from "@/components/FileMentionPopover";
import { McpDialog } from "@/components/McpDialog";
import { ModelSelector } from "@/components/ModelSelector";
import { SkillsDialog } from "@/components/SkillsDialog";
import {
	SlashCommandPopover,
	useFilteredCommands,
} from "@/components/SlashCommandPopover";
import { Button } from "@/components/ui/button";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
	Tooltip,
	TooltipContent,
	TooltipProvider,
	TooltipTrigger,
} from "@/components/ui/tooltip";
import { VariantSelector } from "@/components/VariantSelector";
import { WorktreeDialog } from "@/components/WorktreeDialog";
import {
	type QueueMode,
	useActions,
	useConnectionState,
	useModelState,
	useSessionState,
} from "@/hooks/use-opencode";
import { useSTT } from "@/hooks/useSTT";
import { MAX_TEXTAREA_HEIGHT_PX, STORAGE_KEYS } from "@/lib/constants";
import { canNavigateHistoryAtCursor } from "@/lib/prompt-history";
import { storageGet } from "@/lib/safe-storage";
import { getSessionDraftKey } from "@/lib/session-drafts";
import { cn, getPrimaryAgents } from "@/lib/utils";

interface PromptBoxProps
	extends Omit<React.TextareaHTMLAttributes<HTMLTextAreaElement>, "onSubmit"> {
	onSubmit?: (
		message: string,
		images?: string[],
		mode?: QueueMode,
	) => void | Promise<void>;
	onStop?: () => void;
	isLoading?: boolean;
	autoFocus?: boolean;
	/** Percentage of context window consumed (0-100), null if unknown */
	contextPercent?: number | null;
	/** Total tokens in the context window */
	contextTokens?: number | null;
	/** Cost of the last assistant message in USD */
	contextCost?: number | null;
	/** Maximum context window size in tokens */
	contextLimit?: number | null;
}

const TARGET_IMAGE_SIZE = 4.5 * 1024 * 1024; // Target slightly under 5 MB
const MAX_DIMENSION = 4096; // Max width/height

async function compressImage(file: File): Promise<string> {
	const dataUrl = await readFileAsDataURL(file);
	if (file.size <= TARGET_IMAGE_SIZE) {
		return dataUrl;
	}

	return new Promise((resolve, reject) => {
		const img = new Image();
		img.onload = () => {
			const canvas = document.createElement("canvas");
			let width = img.width;
			let height = img.height;

			if (width > MAX_DIMENSION || height > MAX_DIMENSION) {
				const ratio = Math.min(MAX_DIMENSION / width, MAX_DIMENSION / height);
				width = Math.round(width * ratio);
				height = Math.round(height * ratio);
			}

			canvas.width = width;
			canvas.height = height;
			const ctx = canvas.getContext("2d");
			if (!ctx) {
				reject(new Error("Failed to get canvas context"));
				return;
			}
			ctx.fillStyle = "white";
			ctx.fillRect(0, 0, width, height);
			ctx.drawImage(img, 0, 0, width, height);

			let quality = 0.9;
			const tryCompress = () => {
				const result = canvas.toDataURL("image/jpeg", quality);
				const base64Length = result.length - "data:image/jpeg;base64,".length;
				const byteSize = Math.round((base64Length * 3) / 4);

				if (byteSize <= TARGET_IMAGE_SIZE) {
					resolve(result);
				} else if (quality > 0.1) {
					quality -= 0.1;
					tryCompress();
				} else {
					console.warn(
						`Image still exceeds target size (${byteSize} bytes) even at minimum quality. Returning low-quality result.`,
					);
					resolve(result);
				}
			};
			tryCompress();
			img.src = "";
		};
		img.onerror = () => {
			reject(new Error("Failed to load image. The file may be corrupt."));
		};
		img.src = dataUrl;
	});
}

function readFileAsDataURL(file: File): Promise<string> {
	return new Promise((resolve, reject) => {
		const reader = new FileReader();
		reader.onloadend = () => resolve(reader.result as string);
		reader.onerror = reject;
		reader.readAsDataURL(file);
	});
}

export const PromptBox = React.forwardRef<HTMLTextAreaElement, PromptBoxProps>(
	(
		{
			className,
			onSubmit,
			onStop,
			isLoading,
			autoFocus,
			contextPercent,
			contextTokens,
			contextCost,
			contextLimit,
			...props
		},
		ref,
	) => {
		const internalTextareaRef = React.useRef<HTMLTextAreaElement>(null);
		const fileInputRef = React.useRef<HTMLInputElement>(null);
		const containerRef = React.useRef<HTMLDivElement>(null);
		const [value, setValue] = React.useState("");
		const [imagePreviews, setImagePreviews] = React.useState<string[]>([]);
		const [isDragging, setIsDragging] = React.useState(false);
		const [mcpDialogOpen, setMcpDialogOpen] = React.useState(false);
		const [skillsDialogOpen, setSkillsDialogOpen] = React.useState(false);
		const [worktreeDialogDir, setWorktreeDialogDir] = React.useState<
			string | null
		>(null);

		// Queue mode: how a message is dispatched when the session is busy
		const [queueMode, setQueueMode] = React.useState<QueueMode>("queue");

		// Message history navigation state
		// -1 = not browsing, 0 = most recent user message, incrementing = older
		const [historyIndex, setHistoryIndex] = React.useState(-1);
		const [savedDraft, setSavedDraft] = React.useState("");
		const isApplyingHistoryRef = React.useRef(false);

		// STT endpoint from localStorage (set in Settings > General)
		const [sttEndpoint, setSttEndpoint] = React.useState<string | undefined>(
			() => storageGet(STORAGE_KEYS.STT_ENDPOINT) || undefined,
		);

		// Listen for storage changes (when the user sets the endpoint in settings)
		React.useEffect(() => {
			const onStorage = (e: StorageEvent) => {
				if (e.key === STORAGE_KEYS.STT_ENDPOINT) {
					setSttEndpoint(e.newValue || undefined);
				}
			};
			window.addEventListener("storage", onStorage);

			// Also handle same-tab updates via a custom event
			const onCustom = () => {
				setSttEndpoint(storageGet(STORAGE_KEYS.STT_ENDPOINT) || undefined);
			};
			window.addEventListener("stt-endpoint-changed", onCustom);

			return () => {
				window.removeEventListener("storage", onStorage);
				window.removeEventListener("stt-endpoint-changed", onCustom);
			};
		}, []);

		const {
			isAvailable: isSttAvailable,
			isRecording,
			isTranscribing,
			error: sttError,
			startRecording,
			stopRecording,
		} = useSTT(sttEndpoint);
		const isDisabled = Boolean(props.disabled);

		const {
			setAgent,
			sendCommand,
			findFiles,
			setDraftDirectory,
			setSessionDraft,
			clearSessionDraft,
			registerWorktree,
			connectToProject,
		} = useActions();
		const { commands, agents, selectedAgent } = useModelState();
		const {
			sessions,
			messages,
			activeSessionId,
			draftSessionDirectory,
			sessionDrafts,
		} = useSessionState();
		const { worktreeParents } = useConnectionState();
		const syncingDraftRef = React.useRef(false);
		const sessionDraftsRef = React.useRef(sessionDrafts);

		// Slash command popover state
		const [showSlash, setShowSlash] = React.useState(false);
		const [slashFilter, setSlashFilter] = React.useState("");
		const [slashActiveIndex, setSlashActiveIndex] = React.useState(0);
		const filteredSlashCommands = useFilteredCommands(commands, slashFilter);

		// @file mention popover state
		const [showFileMention, setShowFileMention] = React.useState(false);
		const [fileMentionResults, setFileMentionResults] = React.useState<
			string[]
		>([]);
		const [fileMentionActiveIndex, setFileMentionActiveIndex] =
			React.useState(0);
		const [fileMentionLoading, setFileMentionLoading] = React.useState(false);
		const [fileMentionEmptyMessage, setFileMentionEmptyMessage] =
			React.useState<string | null>(null);
		// Position of the "@" character that triggered the popover
		const fileMentionAnchorRef = React.useRef(-1);
		const fileMentionDebounceRef = React.useRef<ReturnType<
			typeof setTimeout
		> | null>(null);

		const primaryAgents = React.useMemo(
			() => getPrimaryAgents(agents).map((a) => a.name),
			[agents],
		);

		const currentDraftKey = React.useMemo(
			() =>
				getSessionDraftKey({
					sessionId: activeSessionId,
					directory: activeSessionId ? null : draftSessionDirectory,
				}),
			[activeSessionId, draftSessionDirectory],
		);

		React.useEffect(() => {
			sessionDraftsRef.current = sessionDrafts;
		}, [sessionDrafts]);

		// Derive user message history from current session (newest first)
		const userHistory = React.useMemo(
			() =>
				messages
					.filter((m) => m.info.role === "user")
					.map((m) =>
						m.parts
							.filter((p) => p.type === "text")
							.map((p) => ("text" in p ? p.text : ""))
							.join(""),
					)
					.filter((text) => text.length > 0)
					.reverse(),
			[messages],
		);

		// Reset history navigation when switching sessions
		// biome-ignore lint/correctness/useExhaustiveDependencies: intentionally resetting on session change only
		React.useEffect(() => {
			setHistoryIndex(-1);
			setSavedDraft("");
		}, [currentDraftKey]);

		React.useEffect(() => {
			syncingDraftRef.current = true;
			setValue(
				currentDraftKey
					? (sessionDraftsRef.current[currentDraftKey] ?? "")
					: "",
			);
			setImagePreviews([]);
			setShowSlash(false);
			setShowFileMention(false);
			setFileMentionResults([]);
			setFileMentionEmptyMessage(null);
			fileMentionAnchorRef.current = -1;
		}, [currentDraftKey]);

		React.useEffect(() => {
			if (!currentDraftKey) return;
			if (syncingDraftRef.current) {
				syncingDraftRef.current = false;
				return;
			}
			const existingDraft = sessionDrafts[currentDraftKey] ?? "";
			if (value.trim().length === 0) {
				if (existingDraft) clearSessionDraft(currentDraftKey);
				return;
			}
			if (existingDraft !== value) {
				setSessionDraft(currentDraftKey, value);
			}
		}, [
			clearSessionDraft,
			currentDraftKey,
			sessionDrafts,
			setSessionDraft,
			value,
		]);

		const handleMicClick = React.useCallback(async () => {
			if (isDisabled) return;
			if (isTranscribing) return;
			if (isRecording) {
				const result = await stopRecording();
				if (result?.text) {
					setValue((prev) => (prev ? `${prev} ${result.text}` : result.text));
					internalTextareaRef.current?.focus();
				}
			} else {
				try {
					await startRecording();
				} catch {
					// error is in hook state
				}
			}
		}, [
			isDisabled,
			isRecording,
			isTranscribing,
			startRecording,
			stopRecording,
		]);

		React.useImperativeHandle(
			ref,
			() => internalTextareaRef.current as HTMLTextAreaElement,
			[],
		);

		// biome-ignore lint/correctness/useExhaustiveDependencies: value is needed to trigger textarea auto-resize on content change
		React.useLayoutEffect(() => {
			const textarea = internalTextareaRef.current;
			if (textarea) {
				textarea.style.height = "auto";
				const newHeight = Math.min(
					textarea.scrollHeight,
					MAX_TEXTAREA_HEIGHT_PX,
				);
				textarea.style.height = `${newHeight}px`;
			}
		}, [value]);

		React.useEffect(() => {
			if (autoFocus) {
				internalTextareaRef.current?.focus();
			}
		}, [autoFocus]);

		const appendImages = React.useCallback(
			async (files: FileList | File[]) => {
				if (isDisabled) return;
				const imageFiles = Array.from(files).filter((f) =>
					f.type.startsWith("image/"),
				);
				if (imageFiles.length === 0) return;
				const results = await Promise.all(imageFiles.map(compressImage));
				setImagePreviews((prev) => [...prev, ...results]);
			},
			[isDisabled],
		);

		// Helper to determine which project directory to search
		const getActiveDirectory = React.useCallback((): string | null => {
			if (activeSessionId) {
				const activeSession = sessions.find((s) => s.id === activeSessionId);
				return activeSession?._projectDir ?? activeSession?.directory ?? null;
			}
			return draftSessionDirectory;
		}, [activeSessionId, sessions, draftSessionDirectory]);

		const handleInputChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
			const newValue = e.target.value;
			setValue(newValue);
			if (props.onChange) props.onChange(e);

			// Reset history navigation when the user types manually
			if (isApplyingHistoryRef.current) {
				isApplyingHistoryRef.current = false;
			} else if (historyIndex >= 0) {
				setHistoryIndex(-1);
				setSavedDraft("");
			}

			// Detect slash command input: "/" at start with no spaces
			const slashMatch = newValue.match(/^\/(\S*)$/);
			if (slashMatch) {
				setSlashFilter(slashMatch[1] ?? "");
				setSlashActiveIndex(0);
				setShowSlash(true);
			} else {
				setShowSlash(false);
			}

			// Detect @file mention: scan backward from cursor for "@"
			const cursorPos = e.target.selectionStart;
			const textBeforeCursor = newValue.slice(0, cursorPos);

			// Find the last "@" that is at start or preceded by whitespace
			let atIndex = -1;
			for (let i = textBeforeCursor.length - 1; i >= 0; i--) {
				const ch = textBeforeCursor[i];
				// If we hit whitespace before finding @, stop (no active mention)
				if (ch === " " || ch === "\n" || ch === "\t") break;
				if (ch === "@") {
					// Valid if at start or preceded by whitespace
					if (i === 0 || /\s/.test(textBeforeCursor[i - 1] ?? "")) {
						atIndex = i;
					}
					break;
				}
			}

			if (atIndex >= 0) {
				const query = textBeforeCursor.slice(atIndex + 1);
				fileMentionAnchorRef.current = atIndex;
				setFileMentionActiveIndex(0);
				setShowFileMention(true);

				// Debounce the API call
				if (fileMentionDebounceRef.current) {
					clearTimeout(fileMentionDebounceRef.current);
				}
				if (query.trim().length === 0) {
					setFileMentionLoading(false);
					setFileMentionResults([]);
					setFileMentionEmptyMessage("Type to search files");
					return;
				}
				setFileMentionEmptyMessage(null);
				setFileMentionLoading(true);
				fileMentionDebounceRef.current = setTimeout(async () => {
					try {
						const activeDir = getActiveDirectory();
						const results = await findFiles(activeDir, query);
						setFileMentionResults(results.slice(0, 20));
						setFileMentionEmptyMessage(
							results.length === 0 ? "No matching files" : null,
						);
					} catch {
						setFileMentionResults([]);
						setFileMentionEmptyMessage("File search failed");
					} finally {
						setFileMentionLoading(false);
					}
				}, 150);
			} else {
				setShowFileMention(false);
				setFileMentionResults([]);
				setFileMentionEmptyMessage(null);
				fileMentionAnchorRef.current = -1;
				if (fileMentionDebounceRef.current) {
					clearTimeout(fileMentionDebounceRef.current);
					fileMentionDebounceRef.current = null;
				}
			}
		};

		const handleFileChange = (event: React.ChangeEvent<HTMLInputElement>) => {
			if (isDisabled) return;
			if (event.target.files) {
				appendImages(event.target.files);
			}
			event.target.value = "";
		};

		const handleRemoveImage = (
			index: number,
			e: React.MouseEvent<HTMLButtonElement>,
		) => {
			e.stopPropagation();
			setImagePreviews((prev) => prev.filter((_, i) => i !== index));
		};

		const handleDragOver = (e: React.DragEvent) => {
			e.preventDefault();
			e.stopPropagation();
			if (isDisabled) return;
			setIsDragging(true);
		};

		const handleDragLeave = (e: React.DragEvent) => {
			e.preventDefault();
			e.stopPropagation();
			setIsDragging(false);
		};

		const handleDrop = (e: React.DragEvent) => {
			e.preventDefault();
			e.stopPropagation();
			if (isDisabled) return;
			setIsDragging(false);
			if (e.dataTransfer.files.length > 0) {
				appendImages(e.dataTransfer.files);
			}
		};

		const handlePaste = (e: React.ClipboardEvent) => {
			if (isDisabled) return;
			const items = Array.from(e.clipboardData.items);
			const imageFiles: File[] = [];
			for (const item of items) {
				if (item.type.startsWith("image/")) {
					const file = item.getAsFile();
					if (file) imageFiles.push(file);
				}
			}
			if (imageFiles.length > 0) {
				appendImages(imageFiles);
			}
		};

		const hasValue = value.trim().length > 0 || imagePreviews.length > 0;

		const handleFileMentionSelect = React.useCallback(
			(filePath: string) => {
				const anchor = fileMentionAnchorRef.current;
				if (anchor < 0) return;
				const textarea = internalTextareaRef.current;
				const cursorPos = textarea?.selectionStart ?? value.length;

				// Replace @query with @filepath + trailing space
				const before = value.slice(0, anchor);
				const after = value.slice(cursorPos);
				const insertion = `@${filePath} `;
				const newValue = before + insertion + after;

				setValue(newValue);
				setShowFileMention(false);
				setFileMentionResults([]);
				setFileMentionEmptyMessage(null);
				fileMentionAnchorRef.current = -1;

				// Move cursor to after the inserted mention
				const newCursorPos = before.length + insertion.length;
				requestAnimationFrame(() => {
					textarea?.focus();
					textarea?.setSelectionRange(newCursorPos, newCursorPos);
				});
			},
			[value],
		);

		const handleSlashSelect = React.useCallback((cmd: Command) => {
			// Prefill the input with the command name + space for arguments
			const text = `/${cmd.name} `;
			setValue(text);
			setShowSlash(false);
			internalTextareaRef.current?.focus();
		}, []);

		const handleSubmit = async () => {
			if (isDisabled) return;
			if (!hasValue) return;

			// Intercept slash commands
			if (value.startsWith("/")) {
				const trimmed = value.trim();
				const spaceIndex = trimmed.indexOf(" ");
				const commandName =
					spaceIndex > 0 ? trimmed.slice(1, spaceIndex) : trimmed.slice(1);
				const args = spaceIndex > 0 ? trimmed.slice(spaceIndex + 1) : "";

				const cmd = commands.find((c) => c.name === commandName);
				if (cmd) {
					await sendCommand(commandName, args);
					if (currentDraftKey) clearSessionDraft(currentDraftKey);
					setValue("");
					setImagePreviews([]);
					setShowSlash(false);
					setHistoryIndex(-1);
					setSavedDraft("");
					return;
				}
			}

			const images = imagePreviews.length > 0 ? imagePreviews : undefined;
			await onSubmit?.(value, images, isLoading ? queueMode : undefined);
			if (currentDraftKey) clearSessionDraft(currentDraftKey);
			setValue("");
			setImagePreviews([]);
			setHistoryIndex(-1);
			setSavedDraft("");
		};

		const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
			// @file mention popover keyboard navigation
			if (showFileMention && fileMentionResults.length > 0) {
				if (e.key === "ArrowDown") {
					e.preventDefault();
					setFileMentionActiveIndex(
						(prev) => (prev + 1) % fileMentionResults.length,
					);
					return;
				}
				if (e.key === "ArrowUp") {
					e.preventDefault();
					setFileMentionActiveIndex(
						(prev) =>
							(prev - 1 + fileMentionResults.length) %
							fileMentionResults.length,
					);
					return;
				}
				if (e.key === "Tab" || (e.key === "Enter" && !e.shiftKey)) {
					e.preventDefault();
					const file = fileMentionResults[fileMentionActiveIndex];
					if (file) handleFileMentionSelect(file);
					return;
				}
				if (e.key === "Escape") {
					e.preventDefault();
					setShowFileMention(false);
					setFileMentionResults([]);
					fileMentionAnchorRef.current = -1;
					return;
				}
			}

			// Slash popover keyboard navigation
			if (showSlash && filteredSlashCommands.length > 0) {
				if (e.key === "ArrowDown") {
					e.preventDefault();
					setSlashActiveIndex(
						(prev) => (prev + 1) % filteredSlashCommands.length,
					);
					return;
				}
				if (e.key === "ArrowUp") {
					e.preventDefault();
					setSlashActiveIndex(
						(prev) =>
							(prev - 1 + filteredSlashCommands.length) %
							filteredSlashCommands.length,
					);
					return;
				}
				if (e.key === "Tab" || (e.key === "Enter" && !e.shiftKey)) {
					e.preventDefault();
					const cmd = filteredSlashCommands[slashActiveIndex];
					if (cmd) handleSlashSelect(cmd);
					return;
				}
				if (e.key === "Escape") {
					e.preventDefault();
					setShowSlash(false);
					return;
				}
			}

			// Message history navigation (Arrow Up / Arrow Down)
			if (e.key === "ArrowUp" || e.key === "ArrowDown") {
				if (e.altKey || e.ctrlKey || e.metaKey) return;

				const textarea = internalTextareaRef.current;
				if (!textarea) return;

				const cursorPos = textarea.selectionStart;
				const direction = e.key === "ArrowUp" ? "up" : "down";
				const inHistory = historyIndex >= 0;

				if (!canNavigateHistoryAtCursor(direction, value, cursorPos, inHistory))
					return;

				if (direction === "up") {
					if (userHistory.length === 0) return;
					if (historyIndex === -1) {
						// Entering history: save current draft
						const entry = userHistory[0];
						if (entry === undefined) return;
						setSavedDraft(value);
						isApplyingHistoryRef.current = true;
						setHistoryIndex(0);
						setValue(entry);
					} else if (historyIndex < userHistory.length - 1) {
						const next = historyIndex + 1;
						const entry = userHistory[next];
						if (entry === undefined) return;
						isApplyingHistoryRef.current = true;
						setHistoryIndex(next);
						setValue(entry);
					} else {
						return; // already at oldest entry
					}
				} else {
					if (historyIndex <= 0) {
						// Exiting history: restore saved draft
						isApplyingHistoryRef.current = true;
						setHistoryIndex(-1);
						setValue(savedDraft);
					} else {
						const next = historyIndex - 1;
						const entry = userHistory[next];
						if (entry === undefined) return;
						isApplyingHistoryRef.current = true;
						setHistoryIndex(next);
						setValue(entry);
					}
				}
				e.preventDefault();
				return;
			}

			if (e.key === "Enter" && !e.shiftKey) {
				e.preventDefault();
				if (isDisabled) return;
				void handleSubmit();
			}
			if (e.key === "Tab" && primaryAgents.length > 1) {
				e.preventDefault();
				const effective = selectedAgent ?? "build";
				const currentIndex = primaryAgents.indexOf(effective);
				const idx = currentIndex === -1 ? 0 : currentIndex;
				const next = e.shiftKey
					? (idx - 1 + primaryAgents.length) % primaryAgents.length
					: (idx + 1) % primaryAgents.length;
				const nextAgent = primaryAgents[next];
				setAgent(nextAgent === "build" ? null : (nextAgent ?? null));
			}
		};

		return (
			<section
				ref={containerRef}
				aria-label="Message input"
				data-slot="prompt-box"
				onDragOver={handleDragOver}
				onDragLeave={handleDragLeave}
				onDrop={handleDrop}
				className={cn(
					"flex flex-col bg-background px-2 pt-2 shadow-xs transition-colors cursor-text border rounded-xl",
					isDragging && "border-ring ring-ring/50 ring-[3px]",
					className,
				)}
				onClick={() => internalTextareaRef.current?.focus()}
				onKeyDown={(e) => {
					if (e.key === "Enter" && e.target === e.currentTarget) {
						internalTextareaRef.current?.focus();
					}
				}}
			>
				{showFileMention &&
					(fileMentionResults.length > 0 ||
						fileMentionLoading ||
						fileMentionEmptyMessage) && (
						<div className="relative">
							<FileMentionPopover
								files={fileMentionResults}
								activeIndex={fileMentionActiveIndex}
								onSelect={handleFileMentionSelect}
								onHover={setFileMentionActiveIndex}
								loading={fileMentionLoading}
								emptyMessage={fileMentionEmptyMessage}
							/>
						</div>
					)}

				{showSlash && filteredSlashCommands.length > 0 && (
					<div className="relative">
						<SlashCommandPopover
							commands={commands}
							filter={slashFilter}
							activeIndex={slashActiveIndex}
							onSelect={handleSlashSelect}
							onHover={setSlashActiveIndex}
						/>
					</div>
				)}

				<input
					type="file"
					ref={fileInputRef}
					onChange={handleFileChange}
					className="hidden"
					accept="image/*"
					multiple
				/>

				{imagePreviews.length > 0 && (
					<div className="flex flex-wrap gap-2 px-1.5 pt-1.5">
						{imagePreviews.map((img, idx) => (
							<div key={`img-${img.slice(-20)}-${idx}`} className="relative">
								<img
									src={img}
									alt={`Preview ${idx + 1}`}
									className="size-14 rounded-md object-cover"
								/>
								<Button
									variant="secondary"
									size="icon-xs"
									className="absolute -right-1.5 -top-1.5"
									onClick={(e) => handleRemoveImage(idx, e)}
									aria-label="Remove image"
								>
									<X />
								</Button>
							</div>
						))}
					</div>
				)}

				<textarea
					ref={internalTextareaRef}
					data-slot="prompt-box-textarea"
					rows={1}
					value={value}
					onChange={handleInputChange}
					onKeyDown={handleKeyDown}
					onPaste={handlePaste}
					placeholder={
						isDisabled
							? "Select or create a session..."
							: isLoading
								? queueMode === "interrupt"
									? "Interrupt and send..."
									: queueMode === "after-part"
										? "Send after current part..."
										: "Queue a message..."
								: "Message..."
					}
					className="w-full resize-none border-0 bg-transparent px-3 py-2.5 text-sm text-foreground placeholder:text-muted-foreground focus:ring-0 focus-visible:outline-none min-h-10 disabled:cursor-not-allowed disabled:opacity-50"
					{...props}
				/>

				<McpDialog open={mcpDialogOpen} onOpenChange={setMcpDialogOpen} />
				<SkillsDialog
					open={skillsDialogOpen}
					onOpenChange={setSkillsDialogOpen}
				/>
				<WorktreeDialog
					open={worktreeDialogDir !== null}
					onOpenChange={(open) => {
						if (!open) setWorktreeDialogDir(null);
					}}
					directory={worktreeDialogDir ?? ""}
					onCreated={async (worktreePath, branch) => {
						if (!worktreeDialogDir) return;
						registerWorktree(worktreePath, worktreeDialogDir, branch);
						await connectToProject(worktreePath);
						setDraftDirectory(worktreePath);
						setWorktreeDialogDir(null);
					}}
				/>

				<div className="flex min-w-0 items-center gap-1 px-1.5 pb-2">
					<TooltipProvider delayDuration={100}>
						<DropdownMenu>
							<Tooltip>
								<TooltipTrigger asChild>
									<DropdownMenuTrigger asChild>
										<Button
											type="button"
											variant="ghost"
											size="icon-sm"
											disabled={isDisabled}
											onClick={(e) => e.stopPropagation()}
										>
											<Plus />
											<span className="sr-only">Add</span>
										</Button>
									</DropdownMenuTrigger>
								</TooltipTrigger>
								<TooltipContent>Add</TooltipContent>
							</Tooltip>
							<DropdownMenuContent side="top" align="start">
								<DropdownMenuItem
									onClick={(e) => {
										e.stopPropagation();
										fileInputRef.current?.click();
									}}
								>
									<Paperclip className="size-4" />
									Add file
								</DropdownMenuItem>
								<DropdownMenuItem
									onClick={(e) => {
										e.stopPropagation();
										setMcpDialogOpen(true);
									}}
								>
									<Wrench className="size-4" />
									Tools
								</DropdownMenuItem>
								<DropdownMenuItem
									onClick={(e) => {
										e.stopPropagation();
										setSkillsDialogOpen(true);
									}}
								>
									<BookOpen className="size-4" />
									Skills
								</DropdownMenuItem>
							</DropdownMenuContent>
						</DropdownMenu>

						<ModelSelector />
						<AgentSelector />
						<VariantSelector />

						{(() => {
							// Only show in blank (draft) sessions - never in sessions that have messages
							if (!draftSessionDirectory || messages.length > 0) return null;

							// Resolve the project root: if draftSessionDirectory is itself a
							// worktree, look up its parent; otherwise it IS the parent.
							const worktreeMeta = worktreeParents[draftSessionDirectory];
							const projectDir = worktreeMeta
								? worktreeMeta.parentDir
								: draftSessionDirectory;

							// Collect ALL worktrees that belong to this project
							const worktrees = Object.entries(worktreeParents)
								.filter(([, meta]) => meta.parentDir === projectDir)
								.map(([dir, meta]) => ({
									dir,
									branch: meta.branch,
									isMain: false,
								}));

							const options: Array<{
								dir: string;
								branch: string;
								isMain: boolean;
							}> = [
								{ dir: projectDir, branch: "main", isMain: true },
								...worktrees,
							];

							return (
								<DropdownMenu>
									<DropdownMenuTrigger asChild>
										<Button
											variant="ghost"
											size="sm"
											className="!h-7 w-auto max-w-[180px] gap-1.5 border-none bg-transparent px-2 py-0 text-xs text-muted-foreground shadow-none hover:text-foreground focus:ring-0"
										>
											<GitBranch className="size-3.5 shrink-0" />
											<span className="truncate">
												{options.find(
													(opt) => opt.dir === draftSessionDirectory,
												)?.branch || "Branch"}
											</span>
										</Button>
									</DropdownMenuTrigger>
									<DropdownMenuContent align="start" className="max-h-80 w-48">
										{options.map((opt) => (
											<DropdownMenuItem
												key={opt.dir}
												onClick={() => setDraftDirectory(opt.dir)}
												className="text-xs"
											>
												<span className="flex min-w-0 flex-1 items-center gap-1.5">
													{opt.isMain ? (
														<span className="text-[10px] text-muted-foreground">
															main
														</span>
													) : (
														<span className="truncate">{opt.branch}</span>
													)}
												</span>
												{opt.dir === draftSessionDirectory && (
													<Check className="ml-auto size-3 shrink-0" />
												)}
											</DropdownMenuItem>
										))}
										<DropdownMenuSeparator />
										<DropdownMenuItem
											onClick={() => setWorktreeDialogDir(projectDir)}
											className="text-xs"
										>
											<Plus className="size-3.5" />
											<span>New worktree</span>
										</DropdownMenuItem>
									</DropdownMenuContent>
								</DropdownMenu>
							);
						})()}

						{isLoading && (
							<Tooltip>
								<TooltipTrigger asChild>
									<Button
										type="button"
										variant="ghost"
										size="sm"
										className="!h-7 gap-1.5 px-2 text-xs text-muted-foreground hover:text-foreground"
										onClick={(e) => {
											e.stopPropagation();
											setQueueMode((prev) => {
												if (prev === "queue") return "after-part";
												if (prev === "after-part") return "interrupt";
												return "queue";
											});
										}}
									>
										{queueMode === "interrupt" ? (
											<Zap className="size-3.5 shrink-0" />
										) : queueMode === "after-part" ? (
											<ListEnd className="size-3.5 shrink-0" />
										) : (
											<ListEnd className="size-3.5 shrink-0" />
										)}
										<span className="truncate max-w-[100px]">
											{queueMode === "interrupt"
												? "Interrupt"
												: queueMode === "after-part"
													? "After part"
													: "Queue"}
										</span>
									</Button>
								</TooltipTrigger>
								<TooltipContent>
									{queueMode === "interrupt"
										? "Interrupt: abort immediately, then send"
										: queueMode === "after-part"
											? "After part: wait for current part to finish, then send"
											: "Queue: wait for full response, then send"}
								</TooltipContent>
							</Tooltip>
						)}

						<div className="ml-auto flex items-center gap-1.5">
							{contextPercent != null && contextPercent >= 0 && (
								<Tooltip>
									<TooltipTrigger asChild>
										<span
											className={cn(
												"flex items-center gap-1 text-[11px] tabular-nums select-none cursor-default",
												contextPercent >= 90
													? "text-destructive"
													: contextPercent >= 70
														? "text-amber-500"
														: "text-muted-foreground/70",
											)}
										>
											<svg
												width="14"
												height="14"
												viewBox="0 0 20 20"
												className="shrink-0 -rotate-90"
												aria-hidden="true"
											>
												<circle
													cx="10"
													cy="10"
													r="8"
													fill="none"
													stroke="currentColor"
													strokeWidth="2.5"
													opacity="0.2"
												/>
												<circle
													cx="10"
													cy="10"
													r="8"
													fill="none"
													stroke="currentColor"
													strokeWidth="2.5"
													strokeLinecap="round"
													strokeDasharray={`${Math.max(contextPercent, 0) * 0.5027} 50.27`}
												/>
											</svg>
											{contextPercent === 0
												? "0%"
												: contextPercent < 1
													? "<1%"
													: `${contextPercent}%`}
										</span>
									</TooltipTrigger>
									<TooltipContent
										side="top"
										className="flex flex-col gap-1 text-xs"
									>
										<div className="font-semibold">Context window</div>
										{contextTokens != null && contextLimit != null ? (
											<div>
												{contextTokens.toLocaleString()} /{" "}
												{contextLimit.toLocaleString()} tokens
											</div>
										) : contextTokens != null ? (
											<div>{contextTokens.toLocaleString()} tokens</div>
										) : null}
										{contextCost != null && contextCost > 0 && (
											<div>
												Cost: $
												{contextCost < 0.01
													? contextCost.toFixed(6)
													: contextCost.toFixed(4)}
											</div>
										)}
									</TooltipContent>
								</Tooltip>
							)}
							{isSttAvailable && sttError && !hasValue && (
								<span className="text-xs text-destructive max-w-[150px] truncate">
									{sttError}
								</span>
							)}

							{isSttAvailable && (
								<Tooltip>
									<TooltipTrigger asChild>
										<Button
											type="button"
											variant={isRecording ? "destructive" : "ghost"}
											size="icon-sm"
											disabled={isDisabled}
											onClick={(e) => {
												e.stopPropagation();
												handleMicClick();
											}}
											className={cn(
												isRecording && "animate-pulse",
												isTranscribing && "opacity-50 cursor-not-allowed",
											)}
										>
											{isTranscribing ? (
												<Loader2 className="animate-spin size-4" />
											) : isRecording ? (
												<Square className="size-3.5 fill-current" />
											) : (
												<Mic />
											)}
											<span className="sr-only">
												{isRecording ? "Stop recording" : "Voice input"}
											</span>
										</Button>
									</TooltipTrigger>
									<TooltipContent>
										{isTranscribing
											? "Transcribing..."
											: isRecording
												? "Stop recording"
												: "Voice input"}
									</TooltipContent>
								</Tooltip>
							)}

							{isLoading && !hasValue ? (
								<Tooltip>
									<TooltipTrigger asChild>
										<Button
											type="button"
											size="icon-sm"
											variant="default"
											onClick={(e) => {
												e.stopPropagation();
												onStop?.();
											}}
										>
											<Square className="size-3.5 fill-current" />
											<span className="sr-only">Stop generating</span>
										</Button>
									</TooltipTrigger>
									<TooltipContent>Stop</TooltipContent>
								</Tooltip>
							) : (
								<Tooltip>
									<TooltipTrigger asChild>
										<Button
											type="button"
											size="icon-sm"
											variant="default"
											disabled={isDisabled || !hasValue}
											onClick={(e) => {
												e.stopPropagation();
												void handleSubmit();
											}}
										>
											<ArrowUp />
											<span className="sr-only">
												{isLoading
													? queueMode === "interrupt"
														? "Interrupt and send"
														: queueMode === "after-part"
															? "Send after part"
															: "Queue message"
													: "Send message"}
											</span>
										</Button>
									</TooltipTrigger>
									<TooltipContent>
										{isLoading
											? queueMode === "interrupt"
												? "Interrupt & send"
												: queueMode === "after-part"
													? "Send after part"
													: "Queue"
											: "Send"}
									</TooltipContent>
								</Tooltip>
							)}
						</div>
					</TooltipProvider>
				</div>
			</section>
		);
	},
);
PromptBox.displayName = "PromptBox";
