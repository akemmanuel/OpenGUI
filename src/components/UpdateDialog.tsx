import { DialogShell } from "@/components/ui/DialogShell";
import { Button } from "@/components/ui/button";
import type { UpdateCheckResult } from "@/hooks/use-update-check";
import { openExternalLink } from "@/lib/utils";
import packageJson from "../../package.json";

interface UpdateDialogProps {
  update: UpdateCheckResult;
}

function buildDescription(update: UpdateCheckResult): string {
  const { latestVersion } = update;
  if (latestVersion) {
    return `A new version of OpenGUI (${latestVersion}) is available. You are currently running v${packageJson.version}.`;
  }
  return `Current version: v${packageJson.version}.`;
}

export function UpdateDialog({ update }: UpdateDialogProps) {
  const { updateAvailable, releaseUrl, dismiss } = update;

  const open = updateAvailable;
  const description = buildDescription(update);

  return (
    <DialogShell
      open={open}
      onOpenChange={(nextOpen) => !nextOpen && dismiss()}
      title="Update Available"
      description={description}
      footer={
        <>
          <Button variant="outline" onClick={dismiss}>
            Dismiss
          </Button>
          {releaseUrl && (
            <Button
              onClick={() => {
                openExternalLink(releaseUrl);
                dismiss();
              }}
            >
              Open
            </Button>
          )}
        </>
      }
    />
  );
}
