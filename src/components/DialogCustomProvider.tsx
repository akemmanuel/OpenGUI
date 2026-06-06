/**
 * Custom provider form for adding OpenAI-compatible providers.
 *
 * Collects: provider ID, name, base URL, API key, models, custom headers.
 * Saves via config.update() + auth.set().
 */

import { Loader2, Plus, Trash2 } from "lucide-react";
import { type FormEvent, useCallback, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { SubDialogHeader } from "@/components/SubDialogHeader";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type { HarnessId } from "@/agents";
import { useHarness } from "@/hooks/use-agent-backend";
import { useConnectionState } from "@/hooks/use-agent-state";
import { getErrorMessage } from "@/lib/utils";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ModelEntry {
  _key: number;
  id: string;
  name: string;
}

interface HeaderEntry {
  _key: number;
  key: string;
  value: string;
}

const _counter = { value: 1 };
function nextKey() {
  return _counter.value++;
}

// ---------------------------------------------------------------------------
// Reusable key-value list editor (models / headers share the same layout)
// ---------------------------------------------------------------------------

interface KVEntry {
  _key: number;
  first: string;
  second: string;
}

function KeyValueListEditor({
  label,
  entries,
  firstPlaceholder,
  secondPlaceholder,
  firstClassName,
  secondClassName,
  minEntries = 0,
  onAdd,
  onRemove,
  onUpdate,
}: {
  label: React.ReactNode;
  entries: KVEntry[];
  firstPlaceholder: string;
  secondPlaceholder: string;
  firstClassName?: string;
  secondClassName?: string;
  /** Minimum number of entries (hides delete when at this count). */
  minEntries?: number;
  onAdd: () => void;
  onRemove: (idx: number) => void;
  onUpdate: (idx: number, field: "first" | "second", value: string) => void;
}) {
  const { t } = useTranslation();
  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <Label className="text-xs">{label}</Label>
        <Button type="button" variant="ghost" size="sm" className="h-6 text-xs" onClick={onAdd}>
          <Plus className="size-3 mr-1" />
          {t("common.add")}
        </Button>
      </div>
      {entries.map((entry, idx) => (
        <div key={entry._key} className="flex gap-2 items-start">
          <Input
            type="text"
            value={entry.first}
            onChange={(e) => onUpdate(idx, "first", e.target.value)}
            placeholder={firstPlaceholder}
            className={`text-xs flex-1 ${firstClassName ?? ""}`}
          />
          <Input
            type="text"
            value={entry.second}
            onChange={(e) => onUpdate(idx, "second", e.target.value)}
            placeholder={secondPlaceholder}
            className={`text-xs flex-1 ${secondClassName ?? ""}`}
          />
          {entries.length > minEntries && (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-8 w-8 p-0 shrink-0 text-muted-foreground"
              onClick={() => onRemove(idx)}
            >
              <Trash2 className="size-3" />
            </Button>
          )}
        </div>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

interface DialogCustomProviderProps {
  directory?: string;
  harnessId?: HarnessId;
  onSaved: () => void;
  onBack: () => void;
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

const PROVIDER_ID_REGEX = /^[a-z0-9][a-z0-9\-_]*$/;

function validate(
  providerId: string,
  name: string,
  baseUrl: string,
  models: ModelEntry[],
): string | null {
  if (!providerId.trim()) return "providers.providerIdRequired";
  if (!PROVIDER_ID_REGEX.test(providerId)) return "providers.providerIdInvalid";
  if (!name.trim()) return "providers.displayNameRequired";
  if (!baseUrl.trim()) return "providers.baseUrlRequired";
  if (!baseUrl.startsWith("http://") && !baseUrl.startsWith("https://"))
    return "providers.baseUrlInvalid";
  for (const m of models) {
    if (!m.id.trim()) return "providers.modelIdsRequired";
    if (!m.name.trim()) return "providers.modelNamesRequired";
  }
  // Check duplicate model IDs
  const ids = models.map((m) => m.id.trim());
  if (new Set(ids).size !== ids.length) return "providers.duplicateModelIds";
  return null;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function DialogCustomProvider({
  directory,
  harnessId,
  onSaved,
  onBack,
}: DialogCustomProviderProps) {
  const { t } = useTranslation();
  const backend = useHarness(harnessId);
  const providersApi = backend?.platform?.providers;
  const configApi = backend?.platform?.config;
  const { activeWorkspaceId } = useConnectionState();

  const [providerId, setProviderId] = useState("");
  const [name, setName] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [models, setModels] = useState<ModelEntry[]>([{ _key: nextKey(), id: "", name: "" }]);
  const [headers, setHeaders] = useState<HeaderEntry[]>([]);
  const [saving, setSaving] = useState(false);

  const addModel = () => setModels([...models, { _key: nextKey(), id: "", name: "" }]);
  const removeModel = (idx: number) => setModels(models.filter((_, i) => i !== idx));
  const updateModel = (idx: number, field: "id" | "name", value: string) =>
    setModels(models.map((m, i) => (i === idx ? { ...m, [field]: value } : m)));

  const addHeader = () => setHeaders([...headers, { _key: nextKey(), key: "", value: "" }]);
  const removeHeader = (idx: number) => setHeaders(headers.filter((_, i) => i !== idx));
  const updateHeader = (idx: number, field: "key" | "value", value: string) =>
    setHeaders(headers.map((h, i) => (i === idx ? { ...h, [field]: value } : h)));

  const handleSubmit = useCallback(
    async (e: FormEvent) => {
      e.preventDefault();
      if (!providersApi || !configApi) return;

      const validationError = validate(providerId, name, baseUrl, models);
      if (validationError) {
        toast.error(t(validationError));
        return;
      }

      setSaving(true);

      try {
        // Build the models record
        const modelsRecord: Record<string, { name: string }> = {};
        for (const m of models) {
          modelsRecord[m.id.trim()] = { name: m.name.trim() };
        }

        // Build custom headers
        const customHeaders: Record<string, string> = {};
        for (const h of headers) {
          if (h.key.trim()) {
            customHeaders[h.key.trim()] = h.value;
          }
        }

        // Detect {env:VAR_NAME} syntax for API key
        const envMatch = apiKey.match(/^\{env:([^}]+)\}$/);
        const providerConfig: Record<string, unknown> = {
          npm: "@ai-sdk/openai-compatible",
          name: name.trim(),
          options: {
            baseURL: baseUrl.trim(),
            ...(Object.keys(customHeaders).length > 0 ? { headers: customHeaders } : {}),
          },
          models: modelsRecord,
        };
        if (envMatch) {
          providerConfig.env = [envMatch[1]];
        }

        const target = { directory, workspaceId: activeWorkspaceId };

        // Update config to add the custom provider
        await configApi.update(target, {
          provider: {
            [providerId.trim()]: providerConfig,
          },
        });

        // Set the API key if provided (and not an env reference)
        if (apiKey.trim() && !envMatch) {
          await providersApi.connect(target, providerId.trim(), {
            type: "api",
            key: apiKey.trim(),
          });
        }

        await providersApi.dispose(target);
        onSaved();
      } catch (err) {
        toast.error(getErrorMessage(err, "Failed to save"));
      } finally {
        setSaving(false);
      }
    },
    [
      providersApi,
      configApi,
      directory,
      activeWorkspaceId,
      providerId,
      name,
      baseUrl,
      apiKey,
      models,
      headers,
      onSaved,
    ],
  );

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      {/* Header */}
      <SubDialogHeader onBack={onBack}>
        <span className="text-sm font-medium">{t("providers.customProvider")}</span>
      </SubDialogHeader>

      {/* Provider ID */}
      <div className="space-y-1.5">
        <Label htmlFor="custom-id" className="text-xs">
          {t("providers.providerId")}
        </Label>
        <Input
          id="custom-id"
          type="text"
          value={providerId}
          onChange={(e) => setProviderId(e.target.value.toLowerCase())}
          placeholder="my-provider"
          className="font-mono text-sm"
        />
      </div>

      {/* Display name */}
      <div className="space-y-1.5">
        <Label htmlFor="custom-name" className="text-xs">
          {t("providers.displayName")}
        </Label>
        <Input
          id="custom-name"
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="My Provider"
          className="text-sm"
        />
      </div>

      {/* Base URL */}
      <div className="space-y-1.5">
        <Label htmlFor="custom-url" className="text-xs">
          {t("providers.baseUrl")}
        </Label>
        <Input
          id="custom-url"
          type="text"
          value={baseUrl}
          onChange={(e) => setBaseUrl(e.target.value)}
          placeholder="https://api.example.com/v1"
          className="font-mono text-sm"
        />
      </div>

      {/* API Key */}
      <div className="space-y-1.5">
        <Label htmlFor="custom-key" className="text-xs">
          {t("providers.apiKey")}
        </Label>
        <Input
          id="custom-key"
          type="password"
          value={apiKey}
          onChange={(e) => setApiKey(e.target.value)}
          placeholder="sk-... or {env:MY_API_KEY}"
          className="font-mono text-sm"
        />
        <p className="text-[10px] text-muted-foreground">{t("providers.envReferenceHelp")}</p>
      </div>

      {/* Models */}
      <KeyValueListEditor
        label={t("providers.models")}
        entries={models.map((m) => ({
          _key: m._key,
          first: m.id,
          second: m.name,
        }))}
        firstPlaceholder="model-id"
        secondPlaceholder="Display Name"
        firstClassName="font-mono"
        minEntries={0}
        onAdd={addModel}
        onRemove={removeModel}
        onUpdate={(idx, field, value) => updateModel(idx, field === "first" ? "id" : "name", value)}
      />

      {/* Custom headers */}
      <KeyValueListEditor
        label={
          <>
            {t("providers.customHeaders")}{" "}
            <span className="text-muted-foreground">({t("workspace.optional")})</span>
          </>
        }
        entries={headers.map((h) => ({
          _key: h._key,
          first: h.key,
          second: h.value,
        }))}
        firstPlaceholder="Header-Name"
        secondPlaceholder="value"
        onAdd={addHeader}
        onRemove={removeHeader}
        onUpdate={(idx, field, value) =>
          updateHeader(idx, field === "first" ? "key" : "value", value)
        }
      />

      {/* Submit */}
      <Button type="submit" size="sm" className="w-full" disabled={saving}>
        {saving ? (
          <Loader2 className="size-3.5 animate-spin mr-1.5" />
        ) : (
          <Plus className="size-3.5 mr-1.5" />
        )}
        {t("providers.addCustomProvider")}
      </Button>
    </form>
  );
}
