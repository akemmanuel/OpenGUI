import { lazy, Suspense, useEffect, useMemo, useState } from "react";
import { useWorkspaceState } from "@/hooks/use-agent-state";
import { createIdentityClient } from "./identity-client";
import { identityWorkspaceIsLocalBypass } from "./workspace-identity";

const SessionShareDialogContent = lazy(() =>
  import("./SessionShareDialogContent").then((module) => ({
    default: module.SessionShareDialogContent,
  })),
);

export type OpenShareDetail = { sessionId: string; title: string };
export const OPEN_SESSION_SHARE_EVENT = "opengui:open-session-share";

export function openSessionShareDialog(sessionId: string, title: string) {
  window.dispatchEvent(
    new CustomEvent<OpenShareDetail>(OPEN_SESSION_SHARE_EVENT, { detail: { sessionId, title } }),
  );
}

export function SessionShareDialog() {
  const { activeWorkspace: workspace } = useWorkspaceState();
  const client = useMemo(
    () =>
      workspace?.authToken && !identityWorkspaceIsLocalBypass(workspace)
        ? createIdentityClient({ baseUrl: workspace.serverUrl, token: workspace.authToken })
        : null,
    [workspace],
  );
  const [request, setRequest] = useState<{
    session: OpenShareDetail;
    client: NonNullable<typeof client>;
    version: number;
  } | null>(null);

  useEffect(() => {
    if (!client) return;
    const open = (event: Event) => {
      const session = (event as CustomEvent<OpenShareDetail>).detail;
      setRequest((previous) => ({ session, client, version: (previous?.version ?? 0) + 1 }));
    };
    window.addEventListener(OPEN_SESSION_SHARE_EVENT, open);
    return () => window.removeEventListener(OPEN_SESSION_SHARE_EVENT, open);
  }, [client]);

  if (!request || request.client !== client) return null;

  return (
    <Suspense fallback={null}>
      <SessionShareDialogContent
        key={request.version}
        client={request.client}
        session={request.session}
        onClose={() => setRequest(null)}
      />
    </Suspense>
  );
}
