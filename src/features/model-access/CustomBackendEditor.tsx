import { Plus, Trash2 } from "lucide-react";
import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import type { IdentityActor } from "@/features/identity/identity-client";
import {
  emptyUpstreamModel,
  validateCustomBackend,
  type CustomBackendDraft,
  type EditableUpstreamModel,
  type ModelRoute,
} from "./custom-backend";

export function CustomBackendEditor({
  draft,
  actor,
  saving,
  onChange,
  onCancel,
  onSave,
}: {
  draft: CustomBackendDraft;
  actor: IdentityActor | null;
  saving: boolean;
  onChange: (draft: CustomBackendDraft) => void;
  onCancel: () => void;
  onSave: () => void;
}) {
  const { t } = useTranslation();
  const errors = useMemo(() => validateCustomBackend(draft), [draft]);
  const invalid = !!(
    errors.label ||
    errors.baseUrl ||
    errors.models ||
    errors.modelIds.size ||
    errors.contexts.size
  );
  const updateModel = (key: string, patch: Partial<EditableUpstreamModel>) =>
    onChange({
      ...draft,
      models: draft.models.map((model) => (model.key === key ? { ...model, ...patch } : model)),
    });

  return (
    <div className="space-y-5 rounded-lg border p-3 sm:p-4">
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-2">
          <Label htmlFor="custom-backend-name">{t("providers.backendName")}</Label>
          <Input
            id="custom-backend-name"
            value={draft.label}
            aria-invalid={!!errors.label}
            onChange={(event) => onChange({ ...draft, label: event.target.value })}
          />
          {errors.label && (
            <p className="text-xs text-destructive">{t("providers.displayNameRequired")}</p>
          )}
        </div>
        <div className="space-y-2">
          <Label htmlFor="custom-backend-owner">{t("providers.connectionPlane")}</Label>
          <Select
            value={draft.plane}
            onValueChange={(plane) =>
              onChange({ ...draft, plane: plane as CustomBackendDraft["plane"] })
            }
          >
            <SelectTrigger id="custom-backend-owner">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {actor?.type !== "user" || actor.role === "owner" || actor.role === "admin" ? (
                <>
                  <SelectItem value="host">{t("providers.planes.host")}</SelectItem>
                  <SelectItem value="team">{t("providers.planes.team")}</SelectItem>
                </>
              ) : null}
              <SelectItem value="user">{t("providers.planes.user")}</SelectItem>
            </SelectContent>
          </Select>
          <p className="text-xs text-muted-foreground">{t(`providers.planeHelp.${draft.plane}`)}</p>
        </div>
        <div className="space-y-2 sm:col-span-2">
          <Label htmlFor="custom-backend-url">{t("providers.baseUrl")}</Label>
          <Input
            id="custom-backend-url"
            inputMode="url"
            value={draft.baseUrl}
            aria-invalid={!!errors.baseUrl}
            onChange={(event) => onChange({ ...draft, baseUrl: event.target.value })}
          />
          {errors.baseUrl && (
            <p className="text-xs text-destructive">
              {t(
                errors.baseUrl === "required"
                  ? "providers.baseUrlRequired"
                  : "providers.baseUrlInvalid",
              )}
            </p>
          )}
        </div>
        <div className="space-y-2 sm:col-span-2">
          <Label htmlFor="custom-backend-key">{t("providers.apiKey")}</Label>
          <Input
            id="custom-backend-key"
            type="password"
            autoComplete="off"
            value={draft.apiKey}
            onChange={(event) => onChange({ ...draft, apiKey: event.target.value })}
            placeholder={
              draft.id.startsWith("connection_")
                ? t("providers.apiKey")
                : t("providers.keepCredentialPlaceholder")
            }
          />
          <p className="text-xs text-muted-foreground">{t("providers.credentialCustodyHelp")}</p>
        </div>
      </div>

      <fieldset className="space-y-3">
        <legend className="text-sm font-medium">{t("providers.upstreamModels")}</legend>
        <p className="text-xs text-muted-foreground">{t("providers.upstreamModelsHelp")}</p>
        {errors.models && (
          <p role="alert" className="text-xs text-destructive">
            {t(
              errors.models === "duplicate"
                ? "providers.duplicateModelIds"
                : "providers.modelIdsRequired",
            )}
          </p>
        )}
        <div className="divide-y rounded-lg border">
          {draft.models.map((model, index) => (
            <div key={model.key} className="space-y-3 p-3">
              <div className="flex items-center justify-between gap-3">
                <p className="text-xs font-medium text-muted-foreground">
                  {t("providers.modelNumber", { number: index + 1 })}
                </p>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  disabled={draft.models.length === 1}
                  aria-label={t("providers.removeModel", { number: index + 1 })}
                  onClick={() =>
                    onChange({
                      ...draft,
                      models: draft.models.filter((item) => item.key !== model.key),
                    })
                  }
                >
                  <Trash2 />
                </Button>
              </div>
              <div className="grid gap-3 sm:grid-cols-2">
                <div className="space-y-1.5">
                  <Label htmlFor={`${model.key}-id`}>{t("providers.upstreamModelId")}</Label>
                  <Input
                    id={`${model.key}-id`}
                    className="font-mono"
                    value={model.id}
                    aria-invalid={errors.modelIds.has(model.key)}
                    onChange={(event) => updateModel(model.key, { id: event.target.value })}
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor={`${model.key}-name`}>{t("providers.modelDisplayName")}</Label>
                  <Input
                    id={`${model.key}-name`}
                    value={model.displayName}
                    placeholder={t("common.optional")}
                    onChange={(event) =>
                      updateModel(model.key, { displayName: event.target.value })
                    }
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor={`${model.key}-route`}>{t("providers.protocolRoute")}</Label>
                  <Select
                    value={model.route}
                    onValueChange={(route) =>
                      updateModel(model.key, { route: route as ModelRoute })
                    }
                  >
                    <SelectTrigger id={`${model.key}-route`}>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="openai-chat">
                        {t("providers.routes.openai-chat")}
                      </SelectItem>
                      <SelectItem value="responses">{t("providers.routes.responses")}</SelectItem>
                      <SelectItem value="anthropic-messages">
                        {t("providers.routes.anthropic-messages")}
                      </SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor={`${model.key}-context`}>{t("providers.contextWindow")}</Label>
                  <Input
                    id={`${model.key}-context`}
                    type="number"
                    min="1"
                    inputMode="numeric"
                    value={model.context}
                    aria-invalid={errors.contexts.has(model.key)}
                    placeholder={t("common.optional")}
                    onChange={(event) => updateModel(model.key, { context: event.target.value })}
                  />
                </div>
              </div>
              <label className="flex items-center justify-between gap-3 text-sm">
                <span>
                  <span className="block font-medium">{t("providers.reasoningModel")}</span>
                  <span className="block text-xs text-muted-foreground">
                    {t("providers.reasoningModelHelp")}
                  </span>
                </span>
                <Switch
                  checked={model.reasoning}
                  onCheckedChange={(reasoning) => updateModel(model.key, { reasoning })}
                />
              </label>
              <label className="flex items-center gap-2 text-xs">
                <input
                  type="radio"
                  name="default-upstream-model"
                  checked={(draft.defaultModelId || draft.models[0]?.id) === model.id}
                  onChange={() => onChange({ ...draft, defaultModelId: model.id })}
                />
                {t("providers.defaultModel")}
              </label>
            </div>
          ))}
        </div>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => onChange({ ...draft, models: [...draft.models, emptyUpstreamModel()] })}
        >
          <Plus />
          {t("providers.addModel")}
        </Button>
      </fieldset>
      <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
        <Button type="button" variant="ghost" onClick={onCancel}>
          {t("common.cancel")}
        </Button>
        <Button type="button" disabled={invalid || saving} onClick={onSave}>
          {saving ? t("providers.savingBackend") : t("providers.saveBackend")}
        </Button>
      </div>
    </div>
  );
}
