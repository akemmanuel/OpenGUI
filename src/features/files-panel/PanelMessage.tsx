import type { ReactNode } from "react";
import type { HostFileErrorKind } from "./host-file-client";

export function errorMessageKey(kind: HostFileErrorKind, target: "file" | "folder" = "file") {
  if (kind === "forbidden") return "filesPanel.errors.forbidden";
  if (kind === "notFound") return "filesPanel.errors.notFound";
  if (kind === "tooLarge") return "filesPanel.errors.tooLarge";
  return target === "folder" ? "filesPanel.errors.folderFailed" : "filesPanel.errors.fileFailed";
}

/** Centered note for loading, empty, and error states. */
export function PanelMessage({ children }: { children: ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center gap-3 px-6 py-10 text-center text-sm text-muted-foreground">
      {children}
    </div>
  );
}
