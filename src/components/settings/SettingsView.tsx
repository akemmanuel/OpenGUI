import {
  ArrowLeft,
  Bot,
  FolderKey,
  Plug,
  ScrollText,
  Settings2,
  SlidersHorizontal,
  Sparkles,
  Users,
} from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { SettingsProviders } from "@/components/SettingsProviders";
import { GeneralSettings, PathsAndShellSettings } from "@/components/settings/GeneralSettings";
import { Button } from "@/components/ui/button";
import { TeamSettings } from "@/features/identity/TeamSettings";
import { SkillsSettings } from "@/features/skills/SkillsSettings";
import { InstructionsSettings } from "@/features/instructions/InstructionsSettings";
import { McpSettings } from "@/features/mcp/McpSettings";
import { useIdentityActor } from "@/features/identity/identity-actor-context";
import { ownerSettingsVisibility } from "@/features/identity/identity-state";
import {
  getIdentityWorkspace,
  identityWorkspaceIsLocalBypass,
} from "@/features/identity/workspace-identity";

export function SettingsView({ onBack }: { onBack: () => void }) {
  const { t } = useTranslation();
  const [activeTab, setActiveTab] = useState("general");
  const workspace = getIdentityWorkspace();
  const actor = useIdentityActor();
  const localBypass = !!workspace && identityWorkspaceIsLocalBypass(workspace);
  const ownerTabs = ownerSettingsVisibility(actor, localBypass);
  const showOwnerTabs = localBypass || actor?.type === "user";
  const showTeam = ownerTabs.team && !!workspace?.authToken;
  const showHostAdmin = showTeam && actor?.type === "user" && actor.role === "owner";
  const showMcp =
    localBypass || (actor?.type === "user" && (actor.role === "owner" || actor.role === "admin"));
  const sections = [
    { id: "general", icon: SlidersHorizontal, visible: true },
    { id: "models", icon: Bot, visible: showOwnerTabs },
    { id: "integrations", icon: Plug, visible: showMcp },
    { id: "users", icon: Users, visible: showTeam },
    { id: "paths", icon: FolderKey, visible: showTeam || localBypass },
    { id: "host", icon: Settings2, visible: showHostAdmin },
    { id: "instructions", icon: ScrollText, visible: true },
    { id: "skills", icon: Sparkles, visible: true },
  ].filter((item) => item.visible);

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto flex max-w-6xl flex-col gap-5 px-4 py-4 sm:px-6 sm:py-6">
        <div className="space-y-3">
          <Button type="button" variant="ghost" size="sm" className="w-fit" onClick={onBack}>
            <ArrowLeft className="size-4" />
            {t("common.back")}
          </Button>
          <div className="space-y-1">
            <h1 className="text-2xl font-semibold tracking-tight">{t("common.settings")}</h1>
            <p className="text-sm text-muted-foreground">{t("settings.subtitle")}</p>
          </div>
        </div>
        <div className="grid min-w-0 gap-5 md:grid-cols-[13rem_minmax(0,1fr)]">
          <nav aria-label={t("settings.navigationLabel")} className="min-w-0">
            <label htmlFor="settings-section" className="sr-only">
              {t("settings.navigationLabel")}
            </label>
            <select
              id="settings-section"
              className="h-11 w-full rounded-md border bg-background px-3 text-sm md:hidden"
              value={activeTab}
              onChange={(event) => setActiveTab(event.target.value)}
            >
              {sections.map((section) => (
                <option key={section.id} value={section.id}>
                  {t(`settings.tabs.${section.id}`)}
                </option>
              ))}
            </select>
            <div className="hidden space-y-1 md:block">
              {sections.map((section) => (
                <button
                  key={section.id}
                  type="button"
                  aria-current={activeTab === section.id ? "page" : undefined}
                  className={`flex w-full items-center gap-2 rounded-md px-3 py-2 text-left text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${activeTab === section.id ? "bg-accent font-medium text-accent-foreground" : "text-muted-foreground hover:bg-accent/60 hover:text-foreground"}`}
                  onClick={() => setActiveTab(section.id)}
                >
                  <section.icon className="size-4" />
                  {t(`settings.tabs.${section.id}`)}
                </button>
              ))}
            </div>
          </nav>
          <main className="min-w-0 rounded-lg border p-3 sm:p-5">
            <div className="mb-5 min-w-0 space-y-1 border-b pb-4 [overflow-wrap:anywhere]">
              <h2 className="text-lg font-semibold">{t(`settings.tabs.${activeTab}`)}</h2>
              <p className="max-w-2xl text-sm text-muted-foreground">
                {t(`settings.sectionDescriptions.${activeTab}`)}
              </p>
            </div>
            {activeTab === "general" && <GeneralSettings />}
            {activeTab === "models" && <SettingsProviders />}
            {activeTab === "integrations" && <McpSettings />}
            {activeTab === "users" && <TeamSettings view="people" />}
            {activeTab === "paths" && (
              <div className="space-y-6">
                <PathsAndShellSettings />
                {showTeam && <TeamSettings view="paths" />}
              </div>
            )}
            {activeTab === "host" && <TeamSettings view="host" />}
            {activeTab === "instructions" && <InstructionsSettings />}
            {activeTab === "skills" && <SkillsSettings />}
          </main>
        </div>
      </div>
    </div>
  );
}
