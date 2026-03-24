import {
	AlertCircle,
	Loader2,
	Minimize,
	Minus,
	PanelLeftIcon,
	Pencil,
	Plus,
	Square,
	Trash2,
	X,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useActions, useConnectionState } from "@/hooks/use-opencode";

type WindowButtonKind = "default" | "mac";
type MacButtonTone = "close" | "minimize" | "maximize";

function WindowButton({
	icon,
	onClick,
	isClose = false,
	kind = "default",
	macTone = "minimize",
}: {
	icon: React.ReactNode;
	onClick: () => void;
	isClose?: boolean;
	kind?: WindowButtonKind;
	macTone?: MacButtonTone;
}) {
	if (kind === "mac") {
		const colorClasses =
			macTone === "close"
				? "bg-[#ff5f57] border-[#e14640]"
				: macTone === "maximize"
					? "bg-[#28c840] border-[#1fa533]"
					: "bg-[#ffbd2e] border-[#df9e1b]";

		return (
			<button
				type="button"
				onClick={onClick}
				className={`group relative size-3 rounded-full border transition-opacity hover:opacity-95 active:opacity-80 ${colorClasses}`}
				style={{ WebkitAppRegion: "no-drag" } as React.CSSProperties}
			>
				<span className="absolute inset-0 flex items-center justify-center text-black/70 opacity-0 transition-opacity group-hover:opacity-100">
					{icon}
				</span>
			</button>
		);
	}

	return (
		<button
			type="button"
			onClick={onClick}
			className={`w-12 h-9 flex items-center justify-center text-muted-foreground hover:bg-accent active:bg-accent/80 transition-colors ${
				isClose
					? "hover:!bg-red-600 hover:!text-white"
					: "hover:text-foreground"
			}`}
			style={{ WebkitAppRegion: "no-drag" } as React.CSSProperties}
		>
			{icon}
		</button>
	);
}

// ---------------------------------------------------------------------------
// Workspace add/edit dialog
// ---------------------------------------------------------------------------

function WorkspaceDialog({
	open,
	onOpenChange,
	mode,
	initial,
	onSubmit,
	onRemove,
}: {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	mode: "add" | "edit";
	initial: {
		name: string;
		serverUrl: string;
		username: string;
		isLocal: boolean;
	};
	onSubmit: (data: {
		name: string;
		serverUrl: string;
		username?: string;
	}) => void;
	onRemove?: () => void;
}) {
	const [name, setName] = useState(initial.name);
	const [serverUrl, setServerUrl] = useState(initial.serverUrl);
	const [username, setUsername] = useState(initial.username);

	// Reset form when dialog opens with new initial values
	useEffect(() => {
		if (open) {
			setName(initial.name);
			setServerUrl(initial.serverUrl);
			setUsername(initial.username);
		}
	}, [open, initial.name, initial.serverUrl, initial.username]);

	const canSubmit =
		name.trim().length > 0 && (initial.isLocal || serverUrl.trim().length > 0);

	const handleSubmit = () => {
		if (!canSubmit) return;
		onSubmit({
			name: name.trim(),
			serverUrl: serverUrl.trim(),
			username: username.trim() || undefined,
		});
		onOpenChange(false);
	};

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent className="sm:max-w-md">
				<DialogHeader>
					<DialogTitle>
						{mode === "add" ? "Add workspace" : "Edit workspace"}
					</DialogTitle>
					<DialogDescription>
						{mode === "add"
							? "Connect to a remote OpenCode server as a new workspace."
							: "Update this workspace's connection settings."}
					</DialogDescription>
				</DialogHeader>

				<div className="flex flex-col gap-4 py-2">
					<div className="space-y-2">
						<Label htmlFor="ws-name">Name</Label>
						<Input
							id="ws-name"
							value={name}
							onChange={(e) => setName(e.target.value)}
							placeholder="e.g. Cloud Production"
							autoFocus
							onKeyDown={(e) => {
								if (e.key === "Enter") handleSubmit();
							}}
						/>
					</div>

					{(mode === "add" || !initial.isLocal) && (
						<div className="space-y-2">
							<Label htmlFor="ws-url">Server URL</Label>
							<Input
								id="ws-url"
								value={serverUrl}
								onChange={(e) => setServerUrl(e.target.value)}
								placeholder="https://your-server.example.com"
								className="font-mono text-sm"
								onKeyDown={(e) => {
									if (e.key === "Enter") handleSubmit();
								}}
							/>
						</div>
					)}

					<div className="space-y-2">
						<Label htmlFor="ws-username">
							Username{" "}
							<span className="text-muted-foreground font-normal">
								(optional)
							</span>
						</Label>
						<Input
							id="ws-username"
							value={username}
							onChange={(e) => setUsername(e.target.value)}
							placeholder="opencode"
							onKeyDown={(e) => {
								if (e.key === "Enter") handleSubmit();
							}}
						/>
					</div>
				</div>

				<DialogFooter className="flex-row justify-between sm:justify-between">
					{mode === "edit" && onRemove && !initial.isLocal ? (
						<Button
							variant="destructive"
							size="sm"
							onClick={() => {
								onRemove();
								onOpenChange(false);
							}}
						>
							<Trash2 className="size-4 mr-1.5" />
							Remove
						</Button>
					) : (
						<div />
					)}
					<div className="flex gap-2">
						<Button variant="ghost" onClick={() => onOpenChange(false)}>
							Cancel
						</Button>
						<Button disabled={!canSubmit} onClick={handleSubmit}>
							{mode === "add" ? "Add" : "Save"}
						</Button>
					</div>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}

// ---------------------------------------------------------------------------
// Title bar
// ---------------------------------------------------------------------------

export function TitleBar({
	onToggleLeftSidebar,
}: {
	onToggleLeftSidebar?: () => void;
}) {
	const { createWorkspace, removeWorkspace, switchWorkspace, updateWorkspace } =
		useActions();
	const { activeWorkspace, activeWorkspaceId, workspaceStatuses, workspaces } =
		useConnectionState();
	const [isMaximized, setIsMaximized] = useState(false);
	const [platform, setPlatform] = useState<string | null>(null);
	const [dialogMode, setDialogMode] = useState<"add" | "edit" | null>(null);
	const tabsRef = useRef<HTMLDivElement>(null);

	const handleTabsWheel = useCallback((e: React.WheelEvent<HTMLDivElement>) => {
		const container = tabsRef.current;
		if (!container) return;
		if (e.shiftKey && e.deltaY !== 0) {
			e.preventDefault();
			container.scrollLeft += e.deltaY;
		}
	}, []);

	useEffect(() => {
		const api = window.electronAPI;
		if (!api) return;

		api
			.getPlatform()
			.then(setPlatform)
			.catch(() => {});
		api
			.isMaximized()
			.then(setIsMaximized)
			.catch(() => {});
		const unsubscribe = api.onMaximizeChange(setIsMaximized);
		return () => unsubscribe();
	}, []);

	const editingWorkspace = useMemo(
		() =>
			workspaces.find((workspace) => workspace.id === activeWorkspaceId) ??
			null,
		[workspaces, activeWorkspaceId],
	);

	if (!platform) {
		return null;
	}

	const isMac = platform === "darwin";

	const dialogInitial =
		dialogMode === "edit" && editingWorkspace
			? {
					name: editingWorkspace.name,
					serverUrl: editingWorkspace.serverUrl,
					username: editingWorkspace.username ?? "",
					isLocal: editingWorkspace.isLocal,
				}
			: {
					name: "",
					serverUrl: "https://",
					username: "",
					isLocal: false,
				};

	const handleDoubleClick = () => {
		void window.electronAPI?.maximize();
	};

	return (
		<>
			{/* biome-ignore lint/a11y/noStaticElementInteractions: TitleBar double-click to toggle maximize */}
			<div
				className="relative z-20 h-9 bg-sidebar border-b border-border select-none shrink-0"
				style={{ WebkitAppRegion: "drag" } as React.CSSProperties}
				onDoubleClick={handleDoubleClick}
			>
				<div
					className="absolute left-0 top-0 h-full flex items-center px-2"
					style={{ WebkitAppRegion: "no-drag" } as React.CSSProperties}
				>
					{onToggleLeftSidebar && (
						<Button
							data-sidebar="trigger"
							data-slot="sidebar-trigger"
							variant="ghost"
							size="icon"
							className="size-7"
							onClick={onToggleLeftSidebar}
						>
							<PanelLeftIcon />
							<span className="sr-only">Toggle Sidebar</span>
						</Button>
					)}
				</div>

				<div
					className={`absolute inset-y-0 ${isMac ? "left-20 right-20" : "left-12 right-36"} flex items-center gap-1 px-2`}
					style={{ WebkitAppRegion: "no-drag" } as React.CSSProperties}
				>
					<div
						ref={tabsRef}
						onWheel={handleTabsWheel}
						className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto scrollbar-none"
					>
						{workspaces.map((workspace) => {
							const status = workspaceStatuses[workspace.id];
							const active = workspace.id === activeWorkspaceId;
							return (
								<button
									key={workspace.id}
									type="button"
									onClick={() => switchWorkspace(workspace.id)}
									onDoubleClick={(e) => {
										e.stopPropagation();
										switchWorkspace(workspace.id);
										setDialogMode("edit");
									}}
									className={`flex h-7 items-center gap-2 rounded-md border px-3 text-xs transition-colors whitespace-nowrap ${
										active
											? "border-border bg-background text-foreground"
											: "border-transparent bg-transparent text-muted-foreground hover:bg-accent hover:text-foreground"
									}`}
								>
									<span className="truncate max-w-[120px]">
										{workspace.name}
									</span>
									{status?.busy ? (
										<Loader2 className="size-3 animate-spin" />
									) : status?.error ? (
										<AlertCircle className="size-3 text-destructive" />
									) : status?.needsAttention ? (
										<span className="size-2 rounded-full bg-amber-500" />
									) : status?.connected ? (
										<span className="size-2 rounded-full bg-emerald-500" />
									) : null}
								</button>
							);
						})}
						<Button
							variant="ghost"
							size="icon"
							className="size-7 shrink-0"
							onClick={() => setDialogMode("add")}
						>
							<Plus className="size-4" />
							<span className="sr-only">Add workspace</span>
						</Button>
						{activeWorkspace && (
							<Button
								variant="ghost"
								size="icon"
								className="size-7 shrink-0"
								onClick={() => setDialogMode("edit")}
							>
								<Pencil className="size-3.5" />
								<span className="sr-only">Edit workspace</span>
							</Button>
						)}
					</div>
				</div>

				<div
					className={`absolute right-0 top-0 h-full flex items-center gap-2 ${isMac ? "px-2" : "pl-2"}`}
					style={{ WebkitAppRegion: "no-drag" } as React.CSSProperties}
				>
					{isMac ? (
						<div className="flex items-center gap-2">
							<WindowButton
								icon={<Plus className="size-2" strokeWidth={2.75} />}
								onClick={() => window.electronAPI?.maximize()}
								kind="mac"
								macTone="maximize"
							/>
							<WindowButton
								icon={<Minus className="size-2" strokeWidth={2.75} />}
								onClick={() => window.electronAPI?.minimize()}
								kind="mac"
								macTone="minimize"
							/>
							<WindowButton
								icon={<X className="size-2" strokeWidth={2.75} />}
								onClick={() => window.electronAPI?.close()}
								isClose
								kind="mac"
								macTone="close"
							/>
						</div>
					) : (
						<div className="flex items-center">
							<WindowButton
								icon={<Minus className="size-4" />}
								onClick={() => window.electronAPI?.minimize()}
							/>
							<WindowButton
								icon={
									isMaximized ? (
										<Minimize className="size-4" />
									) : (
										<Square className="size-4" />
									)
								}
								onClick={() => window.electronAPI?.maximize()}
							/>
							<WindowButton
								icon={<X className="size-4" />}
								onClick={() => window.electronAPI?.close()}
								isClose
							/>
						</div>
					)}
				</div>
			</div>

			<WorkspaceDialog
				open={dialogMode !== null}
				onOpenChange={(open) => {
					if (!open) setDialogMode(null);
				}}
				mode={dialogMode ?? "add"}
				initial={dialogInitial}
				onSubmit={(data) => {
					if (dialogMode === "add") {
						createWorkspace(data);
					} else if (editingWorkspace) {
						updateWorkspace(editingWorkspace.id, data);
					}
				}}
				onRemove={
					editingWorkspace
						? () => void removeWorkspace(editingWorkspace.id)
						: undefined
				}
			/>
		</>
	);
}
