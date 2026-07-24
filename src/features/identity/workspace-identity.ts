import {
  createLocalWorkspace,
  getActiveWorkspace,
  getStoredWorkspaces,
  persistWorkspaces,
} from "@/lib/persistence";
import { getShellWorkspacePolicy } from "@/runtime/shell-policy";
import type { Workspace } from "@/types/workspace";
import { createIdentityClient } from "./identity-client";

export const WORKSPACE_IDENTITY_CHANGE_EVENT = "opengui:identity-workspace-change";

export function getIdentityWorkspace(): Workspace | null {
  const workspaces = getStoredWorkspaces();
  const policy = getShellWorkspacePolicy();
  return (
    getActiveWorkspace(workspaces) ??
    (policy.shellKind === "mobile" ? null : createLocalWorkspace())
  );
}

export function persistWorkspaceIdentityToken(workspaceId: string, token: string | undefined) {
  const workspaces = getStoredWorkspaces();
  persistWorkspaces(
    workspaces.map((workspace) =>
      workspace.id === workspaceId
        ? {
            ...workspace,
            authToken: token,
            password: undefined,
            settings: { ...workspace.settings, authToken: token, password: undefined },
          }
        : workspace,
    ),
  );
  announceIdentityWorkspaceChange();
}

export async function logoutActiveWorkspaceIdentity() {
  const workspace = getIdentityWorkspace();
  if (!workspace?.authToken || identityWorkspaceIsLocalBypass(workspace)) return;
  try {
    await createIdentityClient({
      baseUrl: workspace.serverUrl,
      token: workspace.authToken,
    }).logout();
  } finally {
    persistWorkspaceIdentityToken(workspace.id, undefined);
  }
}

export function announceIdentityWorkspaceChange() {
  window.dispatchEvent(new Event(WORKSPACE_IDENTITY_CHANGE_EVENT));
}

export function identityWorkspaceIsLocalBypass(workspace: Workspace) {
  const policy = getShellWorkspacePolicy();
  return policy.shellKind === "desktop" && workspace.isLocal;
}
