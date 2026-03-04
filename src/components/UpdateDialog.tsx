import { ExternalLink } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog";
import type { UpdateCheckResult } from "@/hooks/use-update-check";
import { openExternalLink } from "@/lib/utils";
import packageJson from "../../package.json";

interface UpdateDialogProps {
	update: UpdateCheckResult;
}

export function UpdateDialog({ update }: UpdateDialogProps) {
	const { updateAvailable, latestVersion, releaseUrl, dismiss } = update;

	const handleViewRelease = () => {
		if (releaseUrl) openExternalLink(releaseUrl);
		dismiss();
	};

	return (
		<Dialog open={updateAvailable} onOpenChange={(open) => !open && dismiss()}>
			<DialogContent className="sm:max-w-md">
				<DialogHeader>
					<DialogTitle>Update Available</DialogTitle>
					<DialogDescription>
						A new version of OpenGUI ({latestVersion}) is available. You are
						currently running v{packageJson.version}.
					</DialogDescription>
				</DialogHeader>
				<DialogFooter>
					<Button variant="outline" onClick={dismiss}>
						Dismiss
					</Button>
					<Button onClick={handleViewRelease}>
						<ExternalLink className="size-4 mr-2" />
						View Release
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
