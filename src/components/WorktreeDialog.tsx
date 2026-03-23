import { GitBranch } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
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
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/ui/select";
import { getErrorMessage, getProjectName } from "@/lib/utils";

interface WorktreeDialogProps {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	directory: string;
	defaultMode?: "existing" | "new";
	defaultBranch?: string;
	onCreated: (worktreePath: string, branch: string) => void;
}

type BranchMode = "existing" | "new";

export function WorktreeDialog({
	open,
	onOpenChange,
	directory,
	defaultMode = "new",
	defaultBranch = "",
	onCreated,
}: WorktreeDialogProps) {
	const [branches, setBranches] = useState<string[]>([]);
	const [loading, setLoading] = useState(false);
	const [error, setError] = useState<string | null>(null);

	const [mode, setMode] = useState<BranchMode>(defaultMode);
	const [existingBranch, setExistingBranch] = useState("");
	const [newBranch, setNewBranch] = useState("");
	const [worktreePath, setWorktreePath] = useState("");

	const repoName = getProjectName(directory);
	const effectiveBranch = mode === "new" ? newBranch.trim() : existingBranch;

	// Auto-generate path when branch changes
	useEffect(() => {
		if (effectiveBranch) {
			const safeName = effectiveBranch
				.replace(/[^a-zA-Z0-9_.-]/g, "-")
				.replace(/-+/g, "-");
			setWorktreePath(`${directory}/.worktrees/${safeName}`);
		}
	}, [effectiveBranch, directory]);

	// Load branches when dialog opens
	useEffect(() => {
		if (!open) return;
		let cancelled = false;
		setError(null);
		setLoading(true);
		setMode(defaultMode);

		if (defaultMode === "new") {
			setNewBranch(defaultBranch);
			setExistingBranch("");
		} else {
			setNewBranch("");
			setExistingBranch(defaultBranch);
		}

		window.electronAPI?.git
			?.listBranches(directory)
			.then((res) => {
				if (cancelled) return;
				if (res.success && res.data) {
					// Filter out remote tracking refs like "origin/HEAD"
					const local = res.data.filter((b) => !b.startsWith("origin/HEAD"));
					setBranches(local);
				} else {
					setError(res.error ?? "Failed to list branches");
				}
			})
			.catch((err: Error) => {
				if (!cancelled) setError(err.message);
			})
			.finally(() => {
				if (!cancelled) setLoading(false);
			});
		return () => {
			cancelled = true;
		};
	}, [open, directory, defaultBranch, defaultMode]);

	const handleCreate = useCallback(async () => {
		if (!effectiveBranch || !worktreePath.trim()) return;
		setLoading(true);
		setError(null);
		try {
			const res = await window.electronAPI?.git?.addWorktree(
				directory,
				worktreePath.trim(),
				effectiveBranch,
				mode === "new",
			);
			if (res?.success) {
				onCreated(worktreePath.trim(), effectiveBranch);
				onOpenChange(false);
			} else {
				setError(res?.error ?? "Failed to create worktree");
			}
		} catch (err) {
			setError(getErrorMessage(err, "Failed to create worktree"));
		} finally {
			setLoading(false);
		}
	}, [effectiveBranch, worktreePath, directory, mode, onCreated, onOpenChange]);

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent className="sm:max-w-md">
				<DialogHeader>
					<DialogTitle className="flex items-center gap-2">
						<GitBranch className="size-5" />
						New Worktree
					</DialogTitle>
					<DialogDescription>
						Create a new git worktree for{" "}
						<span className="font-medium text-foreground">{repoName}</span>
					</DialogDescription>
				</DialogHeader>

				<div className="grid gap-4 py-2">
					{/* Mode toggle */}
					<div className="grid gap-2">
						<Label>Branch</Label>
						<div className="flex gap-1">
							<Button
								variant={mode === "new" ? "default" : "outline"}
								size="sm"
								onClick={() => setMode("new")}
								className="flex-1"
							>
								New branch
							</Button>
							<Button
								variant={mode === "existing" ? "default" : "outline"}
								size="sm"
								onClick={() => setMode("existing")}
								className="flex-1"
							>
								Existing branch
							</Button>
						</div>
					</div>

					{/* Branch input/selector */}
					{mode === "new" ? (
						<div className="grid gap-2">
							<Label htmlFor="new-branch">Branch name</Label>
							<Input
								id="new-branch"
								placeholder="feature/my-feature"
								value={newBranch}
								onChange={(e) => setNewBranch(e.target.value)}
								onKeyDown={(e) => {
									if (e.key === "Enter" && effectiveBranch && worktreePath) {
										void handleCreate();
									}
								}}
							/>
						</div>
					) : (
						<div className="grid gap-2">
							<Label>Select branch</Label>
							{loading ? (
								<div className="text-sm text-muted-foreground py-2">
									Loading branches...
								</div>
							) : (
								<Select
									value={existingBranch}
									onValueChange={setExistingBranch}
								>
									<SelectTrigger>
										<SelectValue placeholder="Choose a branch..." />
									</SelectTrigger>
									<SelectContent>
										{branches.map((branch) => (
											<SelectItem key={branch} value={branch}>
												{branch}
											</SelectItem>
										))}
									</SelectContent>
								</Select>
							)}
						</div>
					)}

					{/* Path */}
					<div className="grid gap-2">
						<Label htmlFor="wt-path">Worktree path</Label>
						<Input
							id="wt-path"
							value={worktreePath}
							onChange={(e) => setWorktreePath(e.target.value)}
							placeholder="/path/to/worktree"
							className="text-xs font-mono"
						/>
						<p className="text-[11px] text-muted-foreground">
							A new directory will be created at this path.
						</p>
					</div>

					{error && <p className="text-sm text-destructive">{error}</p>}
				</div>

				<DialogFooter>
					<Button variant="outline" onClick={() => onOpenChange(false)}>
						Cancel
					</Button>
					<Button
						onClick={handleCreate}
						disabled={!effectiveBranch || !worktreePath.trim() || loading}
					>
						{loading ? "Creating..." : "Create worktree"}
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
