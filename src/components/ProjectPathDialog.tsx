import { FolderOpen, Server } from "lucide-react";
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
	const resolverRef = useRef<((value: string | null) => void) | null>(null);

	useEffect(() => {
		const handleOpen = (event: Event) => {
			const customEvent = event as CustomEvent<OpenProjectPathDialogDetail>;
			resolverRef.current?.(null);
			resolverRef.current = customEvent.detail.resolve;
			setValue(customEvent.detail.initialPath ?? workspaceDirectory ?? "");
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
		setOpen(false);
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
						{getPromptMessage(isLocalWorkspace)}
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
										const nextPath = await window.electronAPI?.openDirectory();
										if (nextPath) setValue(nextPath);
									}}
								>
									<FolderOpen className="size-4" />
									Browse
								</Button>
							)}
						</div>
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
