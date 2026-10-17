import {
  AccentSetting,
  ChatWidthSetting,
  ContrastSetting,
  ModelAgeFilterSetting,
  NewChatModelSetting,
  NotificationsSetting,
  RespondingSidebarSetting,
  ThemeSetting,
} from "./PreferenceControls";
import { FontSizeSetting } from "./FontSizeSetting";

export function AppearanceSettings() {
  return (
    <div className="max-w-lg space-y-6">
      <ThemeSetting />
      <AccentSetting />
      <FontSizeSetting />
      <ContrastSetting />
      <ChatWidthSetting />
    </div>
  );
}

export function ChatPreferences() {
  return (
    <div className="max-w-lg space-y-6">
      <NewChatModelSetting />
      <ModelAgeFilterSetting />
      <RespondingSidebarSetting />
      <NotificationsSetting />
    </div>
  );
}
