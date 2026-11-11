import { useEffect } from "react";
import { Trans, useTranslation } from "react-i18next";
import { useActions } from "@/hooks/use-agent-state";
import { useSessionSkills } from "@/hooks/use-session-skills";
import { getProjectName } from "@/lib/path";

export function EmptySessionOverview({ directory }: { directory: string | null | undefined }) {
  const { t } = useTranslation();
  const { ensureSessionSkills } = useActions();
  const skillsState = useSessionSkills(directory);

  // Skills are managed in Settings; seed the Session's defaults before the first prompt.
  useEffect(() => {
    if (skillsState.status !== "ready") return;
    ensureSessionSkills(skillsState.skills);
  }, [ensureSessionSkills, skillsState]);

  const projectName = directory ? getProjectName(directory, "") : "";

  return (
    <div className="flex w-full max-w-2xl flex-col items-center px-6 py-8">
      <h1 className="text-center text-2xl font-medium tracking-[-0.02em] text-balance break-words text-muted-foreground sm:text-3xl">
        {projectName ? (
          <Trans
            i18nKey="emptySession.headingInProject"
            values={{ project: projectName }}
            components={{
              project: <span className="text-foreground" />,
            }}
          />
        ) : (
          <span className="text-foreground">{t("emptySession.heading")}</span>
        )}
      </h1>
    </div>
  );
}
