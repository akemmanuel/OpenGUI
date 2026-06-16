import { useTranslation } from "react-i18next";
import { DialogShell } from "@/components/ui/DialogShell";
import { Button } from "@/components/ui/button";
import type { UpdateCheckResult } from "@/hooks/use-update-check";
import { openExternalLink } from "@/lib/utils";
import packageJson from "../../package.json";

interface UpdateDialogProps {
  update: UpdateCheckResult;
}

export function UpdateDialog({ update }: UpdateDialogProps) {
  const { t } = useTranslation();
  const { updateAvailable, releaseUrl, dismiss, latestVersion } = update;

  const open = updateAvailable;
  const description = latestVersion
    ? t("updateDialog.description", {
        latestVersion,
        currentVersion: packageJson.version,
      })
    : t("updateDialog.currentVersion", { currentVersion: packageJson.version });

  return (
    <DialogShell
      open={open}
      onOpenChange={(nextOpen) => !nextOpen && dismiss()}
      title={t("updateDialog.title")}
      description={description}
      footer={
        <>
          <Button variant="outline" onClick={dismiss}>
            {t("updateDialog.dismiss")}
          </Button>
          {releaseUrl && (
            <Button
              onClick={() => {
                openExternalLink(releaseUrl);
                dismiss();
              }}
            >
              {t("updateDialog.open")}
            </Button>
          )}
        </>
      }
    />
  );
}
