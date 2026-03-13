import { GitBranch, Trash2 } from "lucide-react";
import { useCallback, useState } from "react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog";
import { useActions, useConnectionState } from "@/hooks/use-opencode";
import { getProjectName } from "@/lib/utils";

export function WorktreeCleanupDialog() {
	const { pendingWorktreeCleanup, worktreeParents } = useConnectionState();
	const { unregisterWorktree, removeProject, clearWorktreeCleanup } =
		useActions();

	const [deleteFromDisk, setDeleteFromDisk] = useState(true);
	const [removing, setRemoving] = useState(false);

	const isOpen = pendingWorktreeCleanup !== null;
	const worktreeDir = pendingWorktreeCleanup?.worktreeDir ?? "";
	const parentDir = pendingWorktreeCleanup?.parentDir ?? "";
	const meta = worktreeDir ? worktreeParents[worktreeDir] : undefined;

	const handleKeep = useCallback(() => {
		clearWorktreeCleanup();
	}, [clearWorktreeCleanup]);

	const handleRemove = useCallback(async () => {
		if (!worktreeDir || !parentDir) return;
		setRemoving(true);
		try {
			// Unregister from state + disconnect project
			unregisterWorktree(worktreeDir);
			await removeProject(worktreeDir);

			// Optionally remove the git worktree from disk
			if (deleteFromDisk) {
				await window.electronAPI?.git?.removeWorktree(parentDir, worktreeDir);
			}
		} finally {
			setRemoving(false);
			clearWorktreeCleanup();
		}
	}, [
		worktreeDir,
		parentDir,
		deleteFromDisk,
		unregisterWorktree,
		removeProject,
		clearWorktreeCleanup,
	]);

	return (
		<Dialog
			open={isOpen}
			onOpenChange={(open) => {
				if (!open) handleKeep();
			}}
		>
			<DialogContent className="sm:max-w-md">
				<DialogHeader>
					<DialogTitle className="flex items-center gap-2">
						<GitBranch className="size-4" />
						No sessions remaining
					</DialogTitle>
					<DialogDescription>
						The worktree <strong>{getProjectName(worktreeDir)}</strong>
						{meta?.branch && meta.branch !== "unknown" && (
							<>
								{" "}
								(branch{" "}
								<code className="rounded bg-muted px-1 text-xs">
									{meta.branch}
								</code>
								)
							</>
						)}{" "}
						has no active sessions. Would you like to remove it?
					</DialogDescription>
				</DialogHeader>

				<div className="flex items-center gap-2 py-2">
					<Checkbox
						id="delete-from-disk"
						checked={deleteFromDisk}
						onCheckedChange={(checked) => setDeleteFromDisk(checked === true)}
					/>
					<label htmlFor="delete-from-disk" className="cursor-pointer text-sm">
						Also delete worktree files from disk
					</label>
				</div>

				<DialogFooter>
					<Button variant="ghost" onClick={handleKeep} disabled={removing}>
						Keep
					</Button>
					<Button
						variant="destructive"
						onClick={handleRemove}
						disabled={removing}
					>
						<Trash2 className="mr-1.5 size-3.5" />
						{removing ? "Removing..." : "Remove"}
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
