import { Download, ExternalLink, RefreshCw } from "lucide-react";
import { BaseDialog } from "@/components/ui/base-dialog";
import { Button } from "@/components/ui/button";
import type { UpdateCheckResult } from "@/hooks/use-update-check";
import { openExternalLink } from "@/lib/utils";
import packageJson from "../../package.json";

interface UpdateDialogProps {
  update: UpdateCheckResult;
}

function buildDescription(update: UpdateCheckResult): string {
  const { latestVersion, status, progressPercent, errorMessage } = update;
  if (!latestVersion && status === "checking") {
    return `Checking for updates. Current version: v${packageJson.version}.`;
  }
  if (status === "downloading") {
    const percent =
      typeof progressPercent === "number" ? `${Math.round(progressPercent)}%` : "in progress";
    return `OpenGUI ${latestVersion} is downloading in background (${percent}). Current version: v${packageJson.version}.`;
  }
  if (status === "downloaded") {
    return `OpenGUI ${latestVersion} is ready to install. Restart app to finish update from v${packageJson.version}.`;
  }
  if (status === "error") {
    return errorMessage || "Update check failed.";
  }
  if (latestVersion) {
    return `A new version of OpenGUI (${latestVersion}) is available. You are currently running v${packageJson.version}.`;
  }
  return `Current version: v${packageJson.version}.`;
}

export function UpdateDialog({ update }: UpdateDialogProps) {
  const {
    updateAvailable,
    releaseUrl,
    status,
    canDismiss,
    dismiss,
    checkNow,
    download,
    install,
    isElectronManaged,
  } = update;

  const open = updateAvailable || status === "downloaded" || status === "error";
  const description = buildDescription(update);

  const handlePrimary = () => {
    if (status === "downloaded") {
      void install();
      return;
    }
    if (status === "available") {
      if (isElectronManaged) {
        void download();
      } else if (releaseUrl) {
        openExternalLink(releaseUrl);
        dismiss();
      }
      return;
    }
    if (status === "error") {
      void checkNow();
      return;
    }
    if (releaseUrl) openExternalLink(releaseUrl);
  };

  return (
    <BaseDialog
      open={open}
      onOpenChange={(nextOpen) => !nextOpen && canDismiss && dismiss()}
      title={status === "downloaded" ? "Update Ready" : "Update Available"}
      description={description}
      footer={
        <>
          {canDismiss && (
            <Button variant="outline" onClick={dismiss}>
              Later
            </Button>
          )}
          {releaseUrl && status !== "error" && (
            <Button variant="outline" onClick={() => openExternalLink(releaseUrl)}>
              <ExternalLink className="size-4 mr-2" />
              View Release
            </Button>
          )}
          <Button onClick={handlePrimary}>
            {status === "downloaded" ? (
              <>
                <RefreshCw className="size-4 mr-2" />
                Restart to Update
              </>
            ) : status === "available" ? (
              <>
                <Download className="size-4 mr-2" />
                {isElectronManaged ? "Download Update" : "Get Update"}
              </>
            ) : status === "error" ? (
              <>
                <RefreshCw className="size-4 mr-2" />
                Try Again
              </>
            ) : (
              "OK"
            )}
          </Button>
        </>
      }
    />
  );
}
