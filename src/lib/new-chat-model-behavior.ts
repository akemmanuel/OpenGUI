import { STORAGE_KEYS } from "@/lib/constants";
import { storageGet, storageSet } from "@/lib/safe-storage";

export const NEW_CHAT_MODEL_BEHAVIORS = ["ask", "last", "workspace-default"] as const;

export type NewChatModelBehavior = (typeof NEW_CHAT_MODEL_BEHAVIORS)[number];

export const DEFAULT_NEW_CHAT_MODEL_BEHAVIOR: NewChatModelBehavior = "last";

export function isNewChatModelBehavior(value: string | null): value is NewChatModelBehavior {
  return NEW_CHAT_MODEL_BEHAVIORS.includes(value as NewChatModelBehavior);
}

export function getNewChatModelBehavior(): NewChatModelBehavior {
  const stored = storageGet(STORAGE_KEYS.NEW_CHAT_MODEL_BEHAVIOR);
  return isNewChatModelBehavior(stored) ? stored : DEFAULT_NEW_CHAT_MODEL_BEHAVIOR;
}

export function setNewChatModelBehavior(value: NewChatModelBehavior) {
  storageSet(STORAGE_KEYS.NEW_CHAT_MODEL_BEHAVIOR, value);
}

export type NewChatModelBehaviorLabelKey =
  | "settings.general.newChatModelAsk"
  | "settings.general.newChatModelLast"
  | "settings.general.newChatModelWorkspaceDefault";

export function newChatModelBehaviorLabelKey(
  behavior: NewChatModelBehavior,
): NewChatModelBehaviorLabelKey {
  switch (behavior) {
    case "ask":
      return "settings.general.newChatModelAsk";
    case "workspace-default":
      return "settings.general.newChatModelWorkspaceDefault";
    default:
      return "settings.general.newChatModelLast";
  }
}
