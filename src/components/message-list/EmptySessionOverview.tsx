import { Fragment, useEffect } from "react";
import { useTranslation } from "react-i18next";
import logoDark from "@/../assets/opengui-dark.svg";
import logoLight from "@/../assets/opengui-light.svg";
import { useActions, useSessionState } from "@/hooks/use-agent-state";
import { useSessionSkills } from "@/hooks/use-session-skills";
import { defaultEnabledSkillNames } from "@/lib/session-skills";
import { cn } from "@/lib/utils";

export function EmptySessionOverview({ directory }: { directory: string | null | undefined }) {
  const { t } = useTranslation();
  const { ensureSessionSkills, toggleSessionSkill } = useActions();
  const { enabledSkillNames, skillsLocked } = useSessionState();
  const skillsState = useSessionSkills(directory);
  const skills = skillsState.status === "ready" ? skillsState.skills : [];

  useEffect(() => {
    if (skillsState.status !== "ready") return;
    ensureSessionSkills(skillsState.skills);
  }, [ensureSessionSkills, skillsState]);

  // When locked without a stored allowlist (legacy sessions), show defaults read-only.
  const selectedNames =
    enabledSkillNames.length > 0 || !skillsLocked
      ? enabledSkillNames
      : defaultEnabledSkillNames(skills);
  const selected = new Set(selectedNames);

  return (
    <div className="flex w-full max-w-lg flex-col items-center px-6 py-8">
      <img
        src={logoDark}
        alt="OpenGUI"
        draggable={false}
        className="pointer-events-none hidden w-56 select-none dark:block sm:w-64"
      />
      <img
        src={logoLight}
        alt="OpenGUI"
        draggable={false}
        className="pointer-events-none w-56 select-none dark:hidden sm:w-64"
      />

      {skillsState.status === "loading" && (
        <p className="mt-3 h-4 w-48 animate-pulse rounded-sm bg-muted/70" aria-hidden />
      )}

      {skills.length > 0 && (
        <div
          className="mt-3 max-h-[min(14rem,40vh)] max-w-md overflow-y-auto overscroll-contain px-1 text-center text-sm leading-6 text-muted-foreground"
          aria-label={t("emptySession.skillsHeading")}
        >
          {skills.map((skill, index) => {
            const enabled = selected.has(skill.name);
            return (
              <Fragment key={`${skill.source}:${skill.name}`}>
                {index > 0 && <span className="text-muted-foreground/70">, </span>}
                <button
                  type="button"
                  aria-pressed={enabled}
                  disabled={skillsLocked}
                  title={
                    skillsLocked
                      ? t("emptySession.skillsLocked")
                      : enabled
                        ? t("emptySession.disableSkill")
                        : t("emptySession.enableSkill")
                  }
                  onClick={() => toggleSessionSkill(skill.name, skills)}
                  className={cn(
                    "inline rounded-sm align-baseline font-medium transition-colors",
                    "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50",
                    skillsLocked ? "cursor-default" : "cursor-pointer",
                    enabled
                      ? "text-foreground underline underline-offset-2"
                      : "text-muted-foreground hover:text-foreground/70 hover:underline hover:decoration-dotted hover:underline-offset-2",
                    skillsLocked && !enabled && "opacity-50",
                  )}
                >
                  {skill.name}
                </button>
              </Fragment>
            );
          })}
          {skillsLocked && (
            <p className="mt-2 text-xs leading-5">{t("emptySession.skillsRevisionLocked")}</p>
          )}
        </div>
      )}
    </div>
  );
}
