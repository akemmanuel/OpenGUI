import {
	AlertTriangle,
	Check,
	GitBranch,
	GitMerge,
	Loader2,
} from "lucide-react";
import { useCallback, useState } from "react";
import { Button } from "@/components/ui/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog";

type MergeState =
	| { step: "confirm" }
	| { step: "merging" }
	| { step: "success" }
	| { step: "conflicts"; files: string[] }
	| { step: "error"; message: string };

export interface MergeDialogProps {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	/** The main project directory (merge target). */
	mainDirectory: string;
	/** The branch name to merge. */
	branch: string;
	/** Called after successful merge. If deleteWorktree was checked, pass true. */
	onMerged: (deleteWorktree: boolean) => void;
	/** Called when user clicks "Fix with AI". */
	onFixWithAI: (conflicts: string[]) => void;
}

export function MergeDialog({
	open,
	onOpenChange,
	mainDirectory,
	branch,
	onMerged,
	onFixWithAI,
}: MergeDialogProps) {
	const [mergeState, setMergeState] = useState<MergeState>({ step: "confirm" });
	const [deleteWorktree, setDeleteWorktree] = useState(false);

	const repoName = mainDirectory.replace(/\/+$/, "").split("/").pop() ?? "repo";

	const handleClose = useCallback(
		(nextOpen: boolean) => {
			if (!nextOpen) {
				// Reset state on close
				setMergeState({ step: "confirm" });
				setDeleteWorktree(false);
				onOpenChange(false);
			}
		},
		[onOpenChange],
	);

	const handleMerge = useCallback(async () => {
		setMergeState({ step: "merging" });
		const git = window.electronAPI?.git;
		if (!git) {
			setMergeState({ step: "error", message: "Git bridge not available" });
			return;
		}
		try {
			const res = await git.merge(mainDirectory, branch);
			if (res.success) {
				setMergeState({ step: "success" });
				onMerged(deleteWorktree);
			} else if (res.conflicts && res.conflicts.length > 0) {
				setMergeState({ step: "conflicts", files: res.conflicts });
			} else {
				setMergeState({
					step: "error",
					message: res.error ?? "Merge failed",
				});
			}
		} catch (err) {
			setMergeState({
				step: "error",
				message: err instanceof Error ? err.message : String(err),
			});
		}
	}, [mainDirectory, branch, deleteWorktree, onMerged]);

	const handleAbort = useCallback(async () => {
		await window.electronAPI?.git?.mergeAbort(mainDirectory);
		handleClose(false);
	}, [mainDirectory, handleClose]);

	const handleFixWithAI = useCallback(() => {
		if (mergeState.step === "conflicts") {
			onFixWithAI(mergeState.files);
			handleClose(false);
		}
	}, [mergeState, onFixWithAI, handleClose]);

	return (
		<Dialog open={open} onOpenChange={handleClose}>
			<DialogContent className="sm:max-w-md">
				{/* Confirm step */}
				{mergeState.step === "confirm" && (
					<>
						<DialogHeader>
							<DialogTitle className="flex items-center gap-2">
								<GitMerge className="size-5" />
								Merge branch
							</DialogTitle>
							<DialogDescription>
								Merge{" "}
								<span className="font-medium text-foreground">{branch}</span>{" "}
								into the current branch of{" "}
								<span className="font-medium text-foreground">{repoName}</span>
							</DialogDescription>
						</DialogHeader>
						<div className="py-2">
							<label className="flex items-center gap-2 text-sm cursor-pointer">
								<input
									type="checkbox"
									checked={deleteWorktree}
									onChange={(e) => setDeleteWorktree(e.target.checked)}
									className="size-4 rounded border-input"
								/>
								<span>Delete worktree after successful merge</span>
							</label>
							<p className="mt-1 ml-6 text-[11px] text-muted-foreground">
								Removes the worktree directory and disconnects it from the
								project
							</p>
						</div>
						<DialogFooter>
							<Button variant="outline" onClick={() => handleClose(false)}>
								Cancel
							</Button>
							<Button onClick={handleMerge}>Merge</Button>
						</DialogFooter>
					</>
				)}

				{/* Merging step */}
				{mergeState.step === "merging" && (
					<DialogHeader>
						<DialogTitle className="flex items-center gap-2">
							<Loader2 className="size-5 animate-spin" />
							Merging...
						</DialogTitle>
						<DialogDescription>
							Merging{" "}
							<span className="font-medium text-foreground">{branch}</span> into
							the current branch
						</DialogDescription>
					</DialogHeader>
				)}

				{/* Success step */}
				{mergeState.step === "success" && (
					<>
						<DialogHeader>
							<DialogTitle className="flex items-center gap-2 text-green-600">
								<Check className="size-5" />
								Merge successful
							</DialogTitle>
							<DialogDescription>
								<span className="font-medium text-foreground">{branch}</span>{" "}
								has been merged successfully.
								{deleteWorktree && " The worktree will be removed."}
							</DialogDescription>
						</DialogHeader>
						<DialogFooter>
							<Button onClick={() => handleClose(false)}>Done</Button>
						</DialogFooter>
					</>
				)}

				{/* Conflicts step */}
				{mergeState.step === "conflicts" && (
					<>
						<DialogHeader>
							<DialogTitle className="flex items-center gap-2 text-amber-500">
								<AlertTriangle className="size-5" />
								Merge conflicts
							</DialogTitle>
							<DialogDescription>
								Merging{" "}
								<span className="font-medium text-foreground">{branch}</span>{" "}
								produced conflicts in {mergeState.files.length} file
								{mergeState.files.length !== 1 ? "s" : ""}:
							</DialogDescription>
						</DialogHeader>
						<div className="max-h-48 overflow-y-auto rounded-md border bg-muted/50 p-2">
							{mergeState.files.map((file) => (
								<div
									key={file}
									className="flex items-center gap-2 py-1 px-2 text-xs font-mono text-muted-foreground"
								>
									<GitBranch className="size-3 shrink-0" />
									{file}
								</div>
							))}
						</div>
						<DialogFooter className="gap-2 sm:gap-0">
							<Button variant="outline" onClick={handleAbort}>
								Abort merge
							</Button>
							<Button onClick={handleFixWithAI}>Fix with AI</Button>
						</DialogFooter>
					</>
				)}

				{/* Error step */}
				{mergeState.step === "error" && (
					<>
						<DialogHeader>
							<DialogTitle className="flex items-center gap-2 text-destructive">
								<AlertTriangle className="size-5" />
								Merge failed
							</DialogTitle>
							<DialogDescription>{mergeState.message}</DialogDescription>
						</DialogHeader>
						<DialogFooter>
							<Button variant="outline" onClick={() => handleClose(false)}>
								Close
							</Button>
						</DialogFooter>
					</>
				)}
			</DialogContent>
		</Dialog>
	);
}
