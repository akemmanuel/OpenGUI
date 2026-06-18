import { AlertTriangle } from "lucide-react";
import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { HARNESS_LABELS } from "@/agents";
import type { HarnessId } from "@/agents";
import { listProjectHarnessSessionQueryErrors } from "@/hooks/session-query-errors";
import { useConnectionState } from "@/hooks/use-agent-state";
import { makeProjectKey } from "@/hooks/agent-session-utils";
import { getProjectName, normalizeProjectPath } from "@/lib/utils";

interface ProjectHarnessStatusBannerProps {
  activeSessionDirectory: string | null;
  activeWorkspaceId: string;
}

export function ProjectHarnessStatusBanner({
  activeSessionDirectory,
  activeWorkspaceId,
}: ProjectHarnessStatusBannerProps) {
  const { t } = useTranslation();
  const { projectHydration } = useConnectionState();

  const rows = useMemo(() => {
    if (!activeSessionDirectory) return [];
    const normalized = normalizeProjectPath(activeSessionDirectory);
    const projectKey = makeProjectKey(activeWorkspaceId, normalized);
    return listProjectHarnessSessionQueryErrors(projectHydration[projectKey]);
  }, [activeSessionDirectory, activeWorkspaceId, projectHydration]);

  if (rows.length === 0) return null;

  const projectLabel = activeSessionDirectory ? getProjectName(activeSessionDirectory) : "";

  return (
    <div
      className="border-b border-border bg-destructive/5 px-4 py-2 text-sm text-muted-foreground"
      role="status"
    >
      <div className="mx-auto flex max-w-2xl flex-col gap-1.5">
        <div className="flex items-center gap-2 font-medium text-foreground">
          <AlertTriangle className="size-4 shrink-0 text-destructive" aria-hidden />
          <span>{t("projectHarnessStatus.title", { project: projectLabel })}</span>
        </div>
        <ul className="list-none space-y-1 pl-6">
          {rows.map(({ harnessId, error }) => (
            <li key={harnessId}>
              <span className="font-medium text-foreground">
                {HARNESS_LABELS[harnessId as HarnessId] ?? harnessId}
              </span>
              <span className="text-muted-foreground"> — {error}</span>
            </li>
          ))}
        </ul>
        <p className="pl-6 text-xs">{t("projectHarnessStatus.hint")}</p>
      </div>
    </div>
  );
}
