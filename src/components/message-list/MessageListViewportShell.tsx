import { useEffect, useState, type ReactNode } from "react";
import { Spinner } from "@/components/ui/spinner";
import type { MessageListViewportState } from "@/components/message-list/message-list-viewport";
import { EmptySessionOverview } from "@/components/message-list/EmptySessionOverview";

const CENTERED_SHELL = "flex-1 flex items-center justify-center";
const LOADING_INDICATOR_DELAY_MS = 150;

function DelayedLoadingIndicator() {
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    const timer = window.setTimeout(() => setVisible(true), LOADING_INDICATOR_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, []);

  return (
    <div className={CENTERED_SHELL}>
      {visible ? <Spinner className="size-6 text-muted-foreground" /> : null}
    </div>
  );
}

export function MessageListViewportShell({
  viewport,
  directory,
  children,
}: {
  viewport: MessageListViewportState;
  directory?: string | null;
  children: ReactNode;
}) {
  if (viewport.kind === "loading") return <DelayedLoadingIndicator />;

  if (viewport.kind === "error") {
    return (
      <div className={`${CENTERED_SHELL} px-6`}>
        <p className="max-w-md text-center text-sm text-muted-foreground">{viewport.message}</p>
      </div>
    );
  }

  if (viewport.kind === "empty") {
    return (
      <div className={`${CENTERED_SHELL} overflow-y-auto`}>
        <EmptySessionOverview directory={directory} />
      </div>
    );
  }

  return children;
}
