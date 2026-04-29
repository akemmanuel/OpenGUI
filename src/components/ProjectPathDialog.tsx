import { ChevronLeft, Folder, FolderOpen, Server } from "lucide-react";
import { useEffect, useRef, useState } from "react";
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
import { useConnectionState } from "@/hooks/use-agent-state";
import { DEFAULT_SERVER_URL } from "@/lib/constants";
import { normalizeProjectPath } from "@/lib/utils";

interface OpenProjectPathDialogDetail {
	resolve: (value: string | null) => void;
	initialPath?: string;
}

interface ServerDirectoryEntry {
	name: string;
	path: string;
	type: "dir";
}

interface ServerDirectoryListing {
	path: string;
	parent: string | null;
	roots: string[];
	entries: ServerDirectoryEntry[];
}

function isWebRuntime() {
	return !navigator.userAgent.includes("Electron");
}

function getPromptMessage(isLocalWorkspace: boolean) {
	if (isLocalWorkspace) {
		return "Open a local project folder for this window. You can also paste an absolute path manually.";
	}
	return "This window is connected to a remote server, so choose a project by entering the path on that server.";
}

export function ProjectPathDialog() {
	const { isLocalWorkspace, workspaceServerUrl, workspaceDirectory } =
		useConnectionState();
	const [open, setOpen] = useState(false);
	const [value, setValue] = useState("");
	const [showServerBrowser, setShowServerBrowser] = useState(false);
	const [serverListing, setServerListing] = useState<ServerDirectoryListing | null>(null);
	const [serverBrowserError, setServerBrowserError] = useState<string | null>(null);
	const [serverBrowserLoading, setServerBrowserLoading] = useState(false);
	const resolverRef = useRef<((value: string | null) => void) | null>(null);
	const webRuntime = isWebRuntime();

	useEffect(() => {
		const handleOpen = (event: Event) => {
			const customEvent = event as CustomEvent<OpenProjectPathDialogDetail>;
			resolverRef.current?.(null);
			resolverRef.current = customEvent.detail.resolve;
			setValue(customEvent.detail.initialPath ?? workspaceDirectory ?? "");
			setShowServerBrowser(false);
			setOpen(true);
		};

		window.addEventListener(
			"opengui:open-project-path-dialog",
			handleOpen as EventListener,
		);
		return () => {
			window.removeEventListener(
				"opengui:open-project-path-dialog",
				handleOpen as EventListener,
			);
			resolverRef.current?.(null);
			resolverRef.current = null;
		};
	}, [workspaceDirectory]);

	const closeWith = (nextValue: string | null) => {
		const normalizedValue = nextValue ? normalizeProjectPath(nextValue) : null;
		resolverRef.current?.(normalizedValue);
		resolverRef.current = null;
		setShowServerBrowser(false);
		setOpen(false);
	};

	const loadServerDirectory = async (path?: string) => {
		setServerBrowserLoading(true);
		setServerBrowserError(null);
		try {
			const params = new URLSearchParams();
			if (path) params.set("path", path);
			const response = await fetch(`/api/fs/list?${params.toString()}`);
			const body = await response.json();
			if (!response.ok || !body?.ok) throw new Error(body?.error || "Failed to list server folders");
			setServerListing(body.value);
			setValue(body.value.path);
		} catch (error) {
			setServerBrowserError(error instanceof Error ? error.message : String(error));
		} finally {
			setServerBrowserLoading(false);
		}
	};

	const openServerBrowser = () => {
		setShowServerBrowser(true);
		void loadServerDirectory(value.trim() || undefined);
	};

	const selectServerDirectory = (path: string) => {
		setValue(path);
		void loadServerDirectory(path);
	};

	return (
		<Dialog
			open={open}
			onOpenChange={(nextOpen) => {
				if (!nextOpen) closeWith(null);
			}}
		>
			<DialogContent className="sm:max-w-lg">
				<DialogHeader>
					<DialogTitle>Open Project</DialogTitle>
					<DialogDescription>
						{webRuntime && isLocalWorkspace
							? "Choose a project path on the OpenGUI server. If you use this from a phone, paths are server paths, not phone files."
							: getPromptMessage(isLocalWorkspace)}
					</DialogDescription>
				</DialogHeader>

				<div className="space-y-4">
					<div className="rounded-lg border bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
						<div className="flex items-center gap-2">
							<Server className="size-3.5 shrink-0" />
							<span className="font-mono">
								{workspaceServerUrl ?? DEFAULT_SERVER_URL}
							</span>
						</div>
					</div>

					<div className="space-y-2">
						<Label htmlFor="project-path">Project path</Label>
						<div className="flex gap-2">
							<Input
								id="project-path"
								value={value}
								onChange={(event) => setValue(event.target.value)}
								placeholder={
									isLocalWorkspace
										? "/absolute/path/to/project"
										: "/remote/path/to/project"
								}
								className="font-mono text-sm"
								autoFocus
								onKeyDown={(event) => {
									if (event.key === "Enter" && value.trim()) {
										event.preventDefault();
										closeWith(value);
									}
								}}
							/>
							{isLocalWorkspace && window.electronAPI?.openDirectory && (
								<Button
									type="button"
									variant="outline"
									onClick={async () => {
										if (webRuntime) {
											openServerBrowser();
											return;
										}
										const nextPath = await window.electronAPI?.openDirectory();
										if (nextPath) setValue(nextPath);
									}}
								>
									<FolderOpen className="size-4" />
									{webRuntime ? "Browse server" : "Browse"}
								</Button>
							)}
						</div>
						{showServerBrowser && (
							<div className="rounded-lg border bg-muted/20 p-2">
								<div className="mb-2 flex items-center justify-between gap-2 text-xs">
									<span className="truncate font-mono text-muted-foreground">
										{serverListing?.path ?? "Loading server folders..."}
									</span>
									<Button
										type="button"
										variant="ghost"
										size="sm"
										disabled={!serverListing?.parent || serverBrowserLoading}
										onClick={() => serverListing?.parent && selectServerDirectory(serverListing.parent)}
									>
										<ChevronLeft className="size-4" />
										Up
									</Button>
								</div>
								{serverBrowserError && (
									<div className="mb-2 rounded border border-destructive/30 bg-destructive/10 px-2 py-1 text-xs text-destructive">
										{serverBrowserError}
									</div>
								)}
								<div className="max-h-56 overflow-y-auto rounded border bg-background">
									{serverBrowserLoading ? (
										<div className="px-3 py-2 text-xs text-muted-foreground">Loading...</div>
									) : serverListing?.entries.length ? (
										serverListing.entries.map((entry) => (
											<button
												key={entry.path}
												type="button"
												className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm hover:bg-accent"
												onClick={() => selectServerDirectory(entry.path)}
												onDoubleClick={() => closeWith(entry.path)}
											>
												<Folder className="size-4 shrink-0 text-muted-foreground" />
												<span className="truncate">{entry.name}</span>
											</button>
										))
									) : (
										<div className="px-3 py-2 text-xs text-muted-foreground">No folders</div>
									)}
								</div>
								<div className="mt-2 text-[11px] text-muted-foreground">
									Allowed roots: {serverListing?.roots.join(", ") || "server default"}
								</div>
							</div>
						)}
					</div>
				</div>

				<DialogFooter>
					<Button type="button" variant="ghost" onClick={() => closeWith(null)}>
						Cancel
					</Button>
					<Button
						type="button"
						disabled={!value.trim()}
						onClick={() => closeWith(value)}
					>
						Open project
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
