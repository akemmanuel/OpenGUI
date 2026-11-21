import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import { useActions } from "@/hooks/use-agent-state";
import { useSessionSkills } from "@/hooks/use-session-skills";

export function EmptySessionOverview({ directory }: { directory: string | null | undefined }) {
  const { t } = useTranslation();
  const { ensureSessionSkills } = useActions();
  const skillsState = useSessionSkills(directory);

  // Skills are managed in Settings; seed the Session's defaults before the first prompt.
  useEffect(() => {
    if (skillsState.status !== "ready") return;
    ensureSessionSkills(skillsState.skills);
  }, [ensureSessionSkills, skillsState]);

  return (
    <div className="chat-column pt-5 pb-5 md:pb-6">
      <h1 className="text-[1.875rem] leading-tight font-semibold tracking-tight text-balance wrap-anywhere text-foreground sm:text-[2.5rem]">
        {t("emptySession.heading")}
      </h1>
    </div>
  );
}
