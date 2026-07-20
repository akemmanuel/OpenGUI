import { Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
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

export type WorkspaceDialogValues = {
  name: string;
  serverUrl: string;
  authToken: string;
  isLocal: boolean;
};

export function WorkspaceDialog({
  open,
  onOpenChange,
  mode,
  initial,
  onSubmit,
  onRemove,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  mode: "add" | "edit";
  initial: WorkspaceDialogValues;
  onSubmit: (data: { name: string; serverUrl: string; authToken?: string }) => void;
  onRemove?: () => void;
}) {
  const { t } = useTranslation();
  const [name, setName] = useState(initial.name);
  const [serverUrl, setServerUrl] = useState(initial.serverUrl);
  const [authToken, setAuthToken] = useState(initial.authToken);

  useEffect(() => {
    if (open) {
      setName(initial.name);
      setServerUrl(initial.serverUrl);
      setAuthToken(initial.authToken);
    }
  }, [open, initial.name, initial.serverUrl, initial.authToken]);

  const canSubmit = name.trim().length > 0 && (mode === "edit" || serverUrl.trim().length > 0);
  const handleSubmit = () => {
    if (!canSubmit) return;
    onSubmit({
      name: name.trim(),
      serverUrl: mode === "edit" ? initial.serverUrl : serverUrl.trim(),
      authToken: authToken.trim() || undefined,
    });
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>
            {mode === "add" ? t("workspace.addTitle") : t("workspace.editTitle")}
          </DialogTitle>
          <DialogDescription>
            {mode === "add" ? t("workspace.addDescription") : t("workspace.editDescription")}
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-4 py-2">
          <div className="space-y-2">
            <Label htmlFor="ws-name">{t("workspace.name")}</Label>
            <Input
              id="ws-name"
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder={t("workspace.namePlaceholder")}
              autoFocus
              onKeyDown={(event) => event.key === "Enter" && handleSubmit()}
            />
          </div>
          {mode === "add" ? (
            <div className="space-y-2">
              <Label htmlFor="ws-url">{t("workspace.backendUrl")}</Label>
              <Input
                id="ws-url"
                value={serverUrl}
                onChange={(event) => setServerUrl(event.target.value)}
                placeholder={t("workspace.backendUrlPlaceholder")}
                className="font-mono text-sm"
                onKeyDown={(event) => event.key === "Enter" && handleSubmit()}
              />
            </div>
          ) : (
            <div className="space-y-2">
              <Label>{t("workspace.backendUrl")}</Label>
              <div className="border-input bg-muted/40 text-muted-foreground rounded-md border px-3 py-2 font-mono text-sm">
                {initial.serverUrl}
              </div>
            </div>
          )}
          <div className="space-y-2">
            <Label htmlFor="ws-token">
              {t("workspace.accessToken")}{" "}
              <span className="text-muted-foreground font-normal">({t("workspace.optional")})</span>
            </Label>
            <Input
              id="ws-token"
              type="password"
              value={authToken}
              onChange={(event) => setAuthToken(event.target.value)}
              placeholder={t("workspace.accessTokenPlaceholder")}
              onKeyDown={(event) => event.key === "Enter" && handleSubmit()}
            />
          </div>
        </div>
        <DialogFooter className="flex-row justify-between sm:justify-between">
          {mode === "edit" && onRemove && !initial.isLocal ? (
            <Button
              variant="destructive"
              size="sm"
              onClick={() => {
                onRemove();
                onOpenChange(false);
              }}
            >
              <Trash2 className="size-4 mr-1.5" />
              {t("common.remove")}
            </Button>
          ) : (
            <div />
          )}
          <div className="flex gap-2">
            <Button variant="ghost" onClick={() => onOpenChange(false)}>
              {t("common.cancel")}
            </Button>
            <Button disabled={!canSubmit} onClick={handleSubmit}>
              {mode === "add" ? t("common.add") : t("common.save")}
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
