import { ArrowLeft, ShoppingBag } from "lucide-react";
import { useTranslation } from "react-i18next";
import { SettingsProviders } from "@/components/SettingsProviders";
import { GeneralSettings } from "@/components/settings/GeneralSettings";
import { McpTabContent } from "@/components/settings/McpSettings";
import { PluginsTabContent } from "@/components/settings/PluginsSettings";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";

export function SettingsView({ onBack }: { onBack: () => void }) {
  const { t } = useTranslation();

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
        <Tabs defaultValue="general" className="gap-4">
          <TabsList className="w-full">
            <TabsTrigger value="general" className="flex-1">
              {t("settings.tabs.general")}
            </TabsTrigger>
            <TabsTrigger value="providers" className="flex-1">
              {t("settings.tabs.providers")}
            </TabsTrigger>
            <TabsTrigger value="plugins" className="flex-1">
              <ShoppingBag className="size-3.5 mr-1.5" />
              {t("settings.tabs.plugins")}
            </TabsTrigger>
            <TabsTrigger value="mcp" className="flex-1">
              {t("settings.tabs.tools")}
            </TabsTrigger>
          </TabsList>
          <TabsContent value="general" className="mt-0 rounded-lg border p-4">
            <GeneralSettings />
          </TabsContent>
          <TabsContent value="providers" className="mt-0 rounded-lg border p-4">
            <SettingsProviders />
          </TabsContent>
          <TabsContent value="plugins" className="mt-0 rounded-lg border p-4">
            <PluginsTabContent />
          </TabsContent>
          <TabsContent value="mcp" className="mt-0 rounded-lg border p-4">
            <McpTabContent />
          </TabsContent>
        </Tabs>
      </div>
    </div>
  );
}
