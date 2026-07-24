import { ArrowLeft } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { SettingsProviders } from "@/components/SettingsProviders";
import { GeneralSettings } from "@/components/settings/GeneralSettings";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { TeamSettings } from "@/features/identity/TeamSettings";
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

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto flex max-w-3xl flex-col gap-6 px-6 py-6">
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
        <Tabs value={activeTab} onValueChange={setActiveTab} className="gap-4">
          <TabsList className="w-full">
            <TabsTrigger value="general" className="flex-1">
              {t("settings.tabs.general")}
            </TabsTrigger>
            {showOwnerTabs && (
              <TabsTrigger value="providers" className="flex-1">
                {t("settings.tabs.providers")}
              </TabsTrigger>
            )}
            {showTeam && (
              <TabsTrigger value="team" className="flex-1">
                {t("settings.tabs.team")}
              </TabsTrigger>
            )}
          </TabsList>
          <TabsContent value="general" className="mt-0 rounded-lg border p-4">
            <GeneralSettings />
          </TabsContent>
          {showOwnerTabs && (
            <TabsContent value="providers" className="mt-0 rounded-lg border p-4">
              <SettingsProviders />
            </TabsContent>
          )}
          {showTeam && (
            <TabsContent value="team" className="mt-0 rounded-lg border p-4">
              <TeamSettings />
            </TabsContent>
          )}
        </Tabs>
      </div>
    </div>
  );
}
