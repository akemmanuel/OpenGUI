import { Folder, FolderOpen, RotateCcw, Terminal } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Spinner } from "@/components/ui/spinner";
import { useActions, useWorkspaceState } from "@/hooks/use-agent-state";
import { STORAGE_KEYS } from "@/lib/constants";
import { getDesktopShellClient } from "@/runtime/clients";
import { storageGet, storageRemove, storageSet } from "@/lib/persistence/storage";

/** Settings that belong to this computer: folders, helper apps and the local backend. */
export function DesktopSettings() {
  const { t } = useTranslation();
  const shell = getDesktopShellClient();
  const [restarting, setRestarting] = useState(false);

  const handleRestart = useCallback(async () => {
    setRestarting(true);
    try {
      await shell.backend?.restart();
      window.location.reload();
    } catch (error) {
      console.error("Failed to restart local backend", error);
      setRestarting(false);
    }
  }, [shell.backend]);

  return (
    <div className="space-y-6">
      <DefaultChatDirectorySetting />
      <FileManagerSetting />
      <TerminalSetting />
      {shell.backend && (
        <div className="flex flex-col gap-3 border-t pt-5 sm:flex-row sm:items-center sm:justify-between">
          <div className="space-y-1">
            <p className="text-sm font-medium">{t("settings.general.restartLocalBackendTitle")}</p>
            <p className="max-w-[60ch] text-xs text-muted-foreground">
              {t("settings.general.restartLocalBackendDescription")}
            </p>
          </div>
          <AlertDialog>
            <AlertDialogTrigger asChild>
              <Button variant="outline" size="sm" disabled={restarting}>
                {restarting ? <Spinner className="size-3.5" /> : <RotateCcw className="size-3.5" />}
                {t("settings.general.restartLocalBackend")}
              </Button>
            </AlertDialogTrigger>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>
                  {t("settings.general.restartLocalBackendTitle")}
                </AlertDialogTitle>
                <AlertDialogDescription>
                  {t("settings.general.restartLocalBackendDescription")}
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>{t("common.cancel")}</AlertDialogCancel>
                <AlertDialogAction onClick={handleRestart}>{t("common.restart")}</AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Shared storage-input setting
// ---------------------------------------------------------------------------

function StorageInputSetting({
  storageKey,
  id,
  icon: Icon,
  label,
  placeholder,
  helpText,
  inputType,
  onChangeExtra,
}: {
  storageKey: string;
  id: string;
  icon: LucideIcon;
  label: string;
  placeholder: string;
  helpText: string;
  inputType?: string;
  onChangeExtra?: () => void;
}) {
  const [value, setValue] = useState(() => storageGet(storageKey) ?? "");

  const handleChange = (newValue: string) => {
    setValue(newValue);
    if (newValue.trim()) {
      storageSet(storageKey, newValue.trim());
    } else {
      storageRemove(storageKey);
    }
    onChangeExtra?.();
  };

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2">
        <Icon className="size-4 text-muted-foreground" />
        <Label htmlFor={id} className="text-sm font-normal">
          {label}
        </Label>
      </div>
      <Input
        id={id}
        type={inputType}
        value={value}
        onChange={(e) => handleChange(e.target.value)}
        placeholder={placeholder}
        className="font-mono text-sm"
      />
      <p className="text-[11px] text-muted-foreground">{helpText}</p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// File manager setting
// ---------------------------------------------------------------------------

function FileManagerSetting() {
  const { t } = useTranslation();

  return (
    <StorageInputSetting
      storageKey={STORAGE_KEYS.FILE_MANAGER}
      id="file-manager"
      icon={Folder}
      label={t("settings.general.fileManager")}
      placeholder={t("common.autoDetect")}
      helpText={t("settings.general.fileManagerHelp")}
    />
  );
}

// ---------------------------------------------------------------------------
// Terminal setting
// ---------------------------------------------------------------------------

function TerminalSetting() {
  const { t } = useTranslation();

  return (
    <StorageInputSetting
      storageKey={STORAGE_KEYS.TERMINAL}
      id="terminal"
      icon={Terminal}
      label={t("settings.general.terminal")}
      placeholder={t("common.autoDetect")}
      helpText={t("settings.general.terminalHelp")}
    />
  );
}

function DefaultChatDirectorySetting() {
  const { t } = useTranslation();
  const { setDefaultChatDirectory, openDirectory } = useActions();
  const { defaultChatDirectory, supportsNativeDirectoryPicker } = useWorkspaceState();
  const [value, setValue] = useState(defaultChatDirectory ?? "");

  useEffect(() => {
    setValue(defaultChatDirectory ?? "");
  }, [defaultChatDirectory]);

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-2">
        <div className="space-y-1">
          <Label htmlFor="default-chat-directory" className="text-sm font-normal">
            {t("settings.general.defaultChatDirectory")}
          </Label>
          <p className="text-[11px] text-muted-foreground">
            {t("settings.general.defaultChatDirectoryHelp")}
          </p>
        </div>
      </div>
      <div className="flex gap-2">
        <Input
          id="default-chat-directory"
          value={value}
          onChange={(event) => setValue(event.target.value)}
          onBlur={() => setDefaultChatDirectory(value.trim() || null)}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              setDefaultChatDirectory(value.trim() || null);
            }
          }}
          placeholder="/absolute/path/to/chats"
          className="font-mono text-sm"
        />
        {supportsNativeDirectoryPicker && (
          <Button
            type="button"
            variant="outline"
            onClick={async () => {
              const nextDirectory = await openDirectory();
              if (!nextDirectory) return;
              setValue(nextDirectory);
              setDefaultChatDirectory(nextDirectory);
            }}
          >
            <FolderOpen className="size-4" />
            {t("common.browse")}
          </Button>
        )}
      </div>
    </div>
  );
}
