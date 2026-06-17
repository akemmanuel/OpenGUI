import { DEFAULT_SERVER_URL } from "@/lib/constants";
import { getShellWorkspacePolicy, type ShellWorkspacePolicy } from "@/runtime/shell-policy";
import type { Workspace } from "@/types/electron";

export interface WorkspacePresentation {
  /** CONTEXT.md Local Workspace — from `Workspace.isLocal`, not harness adapter kind. */
  isLocalWorkspace: boolean;
  /** Normalized OpenGUI Backend URL for the active workspace. */
  activeBackendUrl: string;
  /** Desktop Shell + Local Workspace: native OS directory picker. */
  supportsNativeDirectoryPicker: boolean;
  /**
   * Base URL for resolving attachment/image paths in the UI.
   * Null when Electron talks to the local backend via same-origin / IPC.
   */
  attachmentBaseUrl: string | null;
}

function normalizeBackendUrl(url: string | undefined | null): string {
  const trimmed = (url ?? "").trim().replace(/\/+$/, "");
  return trimmed || DEFAULT_SERVER_URL;
}

export function resolveWorkspacePresentation(
  activeWorkspace: Workspace | null | undefined,
  shellPolicy: ShellWorkspacePolicy = getShellWorkspacePolicy(),
): WorkspacePresentation {
  const isLocalWorkspace = activeWorkspace?.isLocal === true;
  const activeBackendUrl = normalizeBackendUrl(activeWorkspace?.serverUrl);
  const supportsNativeDirectoryPicker = shellPolicy.shellKind === "desktop" && isLocalWorkspace;
  const attachmentBaseUrl =
    shellPolicy.shellKind === "desktop" && isLocalWorkspace ? null : activeBackendUrl;

  return {
    isLocalWorkspace,
    activeBackendUrl,
    supportsNativeDirectoryPicker,
    attachmentBaseUrl,
  };
}
