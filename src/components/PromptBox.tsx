import type { Command } from "@opencode-ai/sdk/v2/client";
import {
	ArrowUp,
	BookOpen,
	Loader2,
	Mic,
	Paperclip,
	Plus,
	Square,
	Wrench,
	X,
} from "lucide-react";
import * as React from "react";
import { AgentSelector } from "@/components/AgentSelector";
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
	DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
	Tooltip,
	TooltipContent,
	TooltipProvider,
	TooltipTrigger,
} from "@/components/ui/tooltip";
import { VariantSelector } from "@/components/VariantSelector";
import { useOpenCode } from "@/hooks/use-opencode";
import { useSTT } from "@/hooks/useSTT";
import {
	MAX_TEXTAREA_HEIGHT_PX,
	SMALL_WINDOW_BREAKPOINT_PX,
	STORAGE_KEYS,
} from "@/lib/constants";
import { canNavigateHistoryAtCursor } from "@/lib/prompt-history";
import { storageGet } from "@/lib/safe-storage";
import { cn } from "@/lib/utils";

interface PromptBoxProps
	extends Omit<React.TextareaHTMLAttributes<HTMLTextAreaElement>, "onSubmit"> {
	onSubmit?: (message: string, images?: string[]) => void;
	onStop?: () => void;
	isLoading?: boolean;
	autoFocus?: boolean;
	/** Percentage of context window consumed (0-100), null if unknown */
	contextPercent?: number | null;
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
		const [isFullWidth, setIsFullWidth] = React.useState(true);
		const [mcpDialogOpen, setMcpDialogOpen] = React.useState(false);
		const [skillsDialogOpen, setSkillsDialogOpen] = React.useState(false);

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

		const { state, setAgent, sendCommand } = useOpenCode();

		// Slash command popover state
		const [showSlash, setShowSlash] = React.useState(false);
		const [slashFilter, setSlashFilter] = React.useState("");
		const [slashActiveIndex, setSlashActiveIndex] = React.useState(0);
		const filteredSlashCommands = useFilteredCommands(
			state.commands,
			slashFilter,
		);
		const primaryAgents = React.useMemo(() => {
			// Same filtering/sorting as AgentSelector
			return state.agents
				.filter((a) => (a.mode === "primary" || a.mode === "all") && !a.hidden)
				.sort((a, b) => {
					const aIsDefault = a.name === "build" ? 1 : 0;
					const bIsDefault = b.name === "build" ? 1 : 0;
					return bIsDefault - aIsDefault;
				})
				.map((a) => a.name);
		}, [state.agents]);

		// Derive user message history from current session (newest first)
		const userHistory = React.useMemo(
			() =>
				state.messages
					.filter((m) => m.info.role === "user")
					.map((m) =>
						m.parts
							.filter((p) => p.type === "text")
							.map((p) => ("text" in p ? p.text : ""))
							.join(""),
					)
					.filter((text) => text.length > 0)
					.reverse(),
			[state.messages],
		);

		// Reset history navigation when switching sessions
		// biome-ignore lint/correctness/useExhaustiveDependencies: intentionally resetting on session change only
		React.useEffect(() => {
			setHistoryIndex(-1);
			setSavedDraft("");
		}, [state.activeSessionId]);

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

		// Detect whether the prompt box spans edge-to-edge (no visible side gutter).
		// On small windows (< 640px) always treat as constrained (rounded + borders).
		React.useEffect(() => {
			const el = containerRef.current;
			if (!el) return;
			const check = () => {
				if (window.innerWidth < SMALL_WINDOW_BREAKPOINT_PX) {
					setIsFullWidth(false);
					return;
				}
				const rect = el.getBoundingClientRect();
				const hasSideGutter =
					rect.left > 6 && window.innerWidth - rect.right > 6;
				setIsFullWidth(!hasSideGutter);
			};
			check();
			const observer = new ResizeObserver(check);
			observer.observe(el);
			window.addEventListener("resize", check);
			return () => {
				observer.disconnect();
				window.removeEventListener("resize", check);
			};
		}, []);

		const appendImages = React.useCallback(
			async (files: FileList | File[]) => {
				if (isDisabled) return;
				const imageFiles = Array.from(files).filter((f) =>
					f.type.startsWith("image/"),
				);
				if (imageFiles.length === 0) return;
				const results = await Promise.all(imageFiles.map(readFileAsDataURL));
				setImagePreviews((prev) => [...prev, ...results]);
			},
			[isDisabled],
		);

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

		const handleSlashSelect = React.useCallback((cmd: Command) => {
			// Prefill the input with the command name + space for arguments
			const text = `/${cmd.name} `;
			setValue(text);
			setShowSlash(false);
			internalTextareaRef.current?.focus();
		}, []);

		const handleSubmit = () => {
			if (isDisabled) return;
			if (!hasValue) return;

			// Intercept slash commands
			if (value.startsWith("/")) {
				const trimmed = value.trim();
				const spaceIndex = trimmed.indexOf(" ");
				const commandName =
					spaceIndex > 0 ? trimmed.slice(1, spaceIndex) : trimmed.slice(1);
				const args = spaceIndex > 0 ? trimmed.slice(spaceIndex + 1) : "";

				const cmd = state.commands.find((c) => c.name === commandName);
				if (cmd) {
					sendCommand(commandName, args);
					setValue("");
					setImagePreviews([]);
					setShowSlash(false);
					setHistoryIndex(-1);
					setSavedDraft("");
					return;
				}
			}

			const images = imagePreviews.length > 0 ? imagePreviews : undefined;
			onSubmit?.(value, images);
			setValue("");
			setImagePreviews([]);
			setHistoryIndex(-1);
			setSavedDraft("");
		};

		const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
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
				handleSubmit();
			}
			if (e.key === "Tab" && primaryAgents.length > 1) {
				e.preventDefault();
				const effective = state.selectedAgent ?? "build";
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
					"flex flex-col bg-background px-1.5 pt-1.5 shadow-xs transition-colors cursor-text",
					isFullWidth
						? "border-t rounded-none"
						: "border-3 rounded-t-xl border-b-0",
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
				{showSlash && filteredSlashCommands.length > 0 && (
					<div className="relative">
						<SlashCommandPopover
							commands={state.commands}
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
								? "Queue a message..."
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

						<div className="ml-auto flex items-center gap-1.5">
							{contextPercent != null && contextPercent >= 0 && (
								<span
									className={cn(
										"flex items-center gap-1 text-[11px] tabular-nums select-none",
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
												handleSubmit();
											}}
										>
											<ArrowUp />
											<span className="sr-only">
												{isLoading ? "Queue message" : "Send message"}
											</span>
										</Button>
									</TooltipTrigger>
									<TooltipContent>
										{isLoading ? "Queue" : "Send"}
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
