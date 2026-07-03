import type { ReactNode } from "react";
import { Spinner } from "@/components/ui/spinner";
import type { MessageListViewportState } from "@/components/message-list/message-list-viewport";
import logoDark from "@/../assets/opengui-dark.svg";
import logoLight from "@/../assets/opengui-light.svg";

const CENTERED_SHELL = "flex-1 flex items-center justify-center";

export function MessageListViewportShell({
  viewport,
  children,
}: {
  viewport: MessageListViewportState;
  children: ReactNode;
}) {
  if (viewport.kind === "loading") {
    return (
      <div className={CENTERED_SHELL}>
        <Spinner className="size-6 text-muted-foreground" />
      </div>
    );
  }

  if (viewport.kind === "error") {
    return (
      <div className={`${CENTERED_SHELL} px-6`}>
        <p className="max-w-md text-center text-sm text-muted-foreground">{viewport.message}</p>
      </div>
    );
  }

  if (viewport.kind === "empty") {
    return (
      <div className={CENTERED_SHELL}>
        <div className="w-full max-w-2xl flex flex-col items-center">
          <img
            src={logoDark}
            alt="OpenGUI"
            draggable={false}
            className="hidden dark:block w-82 select-none pointer-events-none"
          />
          <img
            src={logoLight}
            alt="OpenGUI"
            draggable={false}
            className="dark:hidden w-82 select-none pointer-events-none"
          />
        </div>
      </div>
    );
  }

  return children;
}
