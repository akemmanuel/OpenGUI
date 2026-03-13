import { Loader2, Play, SkipForward, Terminal } from "lucide-react";
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
import { getErrorMessage, getProjectName } from "@/lib/utils";

interface WorktreeSetupDialogProps {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	worktreePath: string;
}

type SetupStep = "detecting" | "prompt" | "running" | "done" | "error";

export function WorktreeSetupDialog({
	open,
	onOpenChange,
	worktreePath,
}: WorktreeSetupDialogProps) {
	const [step, setStep] = useState<SetupStep>("detecting");
	const [command, setCommand] = useState("");
	const [detectedFile, setDetectedFile] = useState("");
	const [error, setError] = useState<string | null>(null);

	// Detect setup command when dialog opens
	useEffect(() => {
		if (!open || !worktreePath) return;
		setStep("detecting");
		setError(null);
		setCommand("");
		setDetectedFile("");

		window.electronAPI?.worktree
			?.detectSetup(worktreePath)
			.then((result) => {
				if (result.detected && result.command) {
					setCommand(result.command);
					setDetectedFile(result.file ?? "");
					setStep("prompt");
				} else {
					// Nothing detected, close silently
					onOpenChange(false);
				}
			})
			.catch(() => {
				onOpenChange(false);
			});
	}, [open, worktreePath, onOpenChange]);

	const handleRun = useCallback(async () => {
		if (!command.trim()) return;
		setStep("running");
		setError(null);
		try {
			const result = await window.electronAPI?.worktree?.runSetup(
				worktreePath,
				command.trim(),
			);
			if (result?.success) {
				setStep("done");
				// Auto-close after a brief pause
				setTimeout(() => onOpenChange(false), 1200);
			} else {
				setError(result?.error ?? "Setup command failed");
				setStep("error");
			}
		} catch (err) {
			setError(getErrorMessage(err, "Setup command failed"));
			setStep("error");
		}
	}, [command, worktreePath, onOpenChange]);

	const handleSkip = useCallback(() => {
		onOpenChange(false);
	}, [onOpenChange]);

	const isRunning = step === "running";
	const projectName = getProjectName(worktreePath);

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent className="sm:max-w-md">
				<DialogHeader>
					<DialogTitle className="flex items-center gap-2">
						<Terminal className="size-4" />
						Worktree Setup
					</DialogTitle>
					<DialogDescription>
						{step === "detecting" && "Detecting project setup..."}
						{step === "prompt" && (
							<>
								Detected{" "}
								<code className="rounded bg-muted px-1 text-xs">
									{detectedFile}
								</code>{" "}
								in <strong>{projectName}</strong>. Run setup?
							</>
						)}
						{step === "running" && "Running setup command..."}
						{step === "done" && "Setup completed successfully."}
						{step === "error" && "Setup command failed."}
					</DialogDescription>
				</DialogHeader>

				{(step === "prompt" || step === "error") && (
					<div className="space-y-3">
						<div className="space-y-1.5">
							<label
								htmlFor="setup-command"
								className="text-xs font-medium text-muted-foreground"
							>
								Command
							</label>
							<Input
								id="setup-command"
								value={command}
								onChange={(e) => setCommand(e.target.value)}
								placeholder="bun install"
								className="font-mono text-sm"
							/>
						</div>
						{error && (
							<p className="rounded border border-destructive/50 bg-destructive/10 p-2 text-xs text-destructive">
								{error}
							</p>
						)}
					</div>
				)}

				{step === "detecting" && (
					<div className="flex items-center justify-center py-4">
						<Loader2 className="size-5 animate-spin text-muted-foreground" />
					</div>
				)}

				{step === "running" && (
					<div className="flex items-center gap-2 py-4">
						<Loader2 className="size-4 animate-spin" />
						<code className="text-sm text-muted-foreground">{command}</code>
					</div>
				)}

				{step === "done" && (
					<p className="py-2 text-sm text-green-600 dark:text-green-400">
						Setup finished - worktree is ready.
					</p>
				)}

				<DialogFooter>
					{(step === "prompt" || step === "error") && (
						<>
							<Button variant="ghost" onClick={handleSkip} disabled={isRunning}>
								<SkipForward className="mr-1.5 size-3.5" />
								Skip
							</Button>
							<Button
								onClick={handleRun}
								disabled={isRunning || !command.trim()}
							>
								<Play className="mr-1.5 size-3.5" />
								Run
							</Button>
						</>
					)}
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
