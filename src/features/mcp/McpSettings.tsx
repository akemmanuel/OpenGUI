import { Plug, Plus, RefreshCw, Trash2, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { getIdentityWorkspace } from "@/features/identity/workspace-identity";
import { notifySuccess, notifyUnknownError } from "@/lib/notify";
import { createHostClient } from "@/protocol/host-client";
import type {
  HostMcpConnection,
  HostMcpConnectionMutation,
  HostMcpToolInfo,
} from "@/protocol/host-types";

type Draft = {
  id: string;
  label: string;
  enabled: boolean;
  kind: "stdio" | "http";
  command: string;
  argumentsText: string;
  cwd: string;
  environmentText: string;
  url: string;
  bearerToken: string;
  commandApproved: boolean;
};

const emptyDraft = (): Draft => ({
  id: "",
  label: "",
  enabled: true,
  kind: "stdio",
  command: "",
  argumentsText: "",
  cwd: "",
  environmentText: "",
  url: "",
  bearerToken: "",
  commandApproved: false,
});

function draftFor(connection: HostMcpConnection): Draft {
  return connection.transport.kind === "stdio"
    ? {
        ...emptyDraft(),
        id: connection.id,
        label: connection.label,
        enabled: connection.enabled,
        command: connection.transport.command,
        argumentsText: connection.transport.args.join("\n"),
        cwd: connection.transport.cwd ?? "",
        environmentText: connection.transport.envKeys.map((key) => `${key}=`).join("\n"),
      }
    : {
        ...emptyDraft(),
        id: connection.id,
        label: connection.label,
        enabled: connection.enabled,
        kind: "http",
        url: connection.transport.url,
      };
}
function parseEnvironment(value: string) {
  const entries = value
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean)
    .flatMap((line): Array<[string, string]> => {
      const separator = line.indexOf("=");
      return separator > 0 ? [[line.slice(0, separator).trim(), line.slice(separator + 1)]] : [];
    })
    .filter(([, value]) => value !== "");
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}
export function McpSettings() {
  const { t } = useTranslation();
  const workspace = useMemo(() => getIdentityWorkspace(), []);
  const host = useMemo(() => {
    const electron = window.electronAPI;
    return createHostClient({
      resolveBaseUrl: () => electron?.backendUrl || workspace?.serverUrl || window.location.origin,
      resolveToken: () => electron?.backendToken || workspace?.authToken || "",
    });
  }, [workspace]);
  const [connections, setConnections] = useState<HostMcpConnection[]>([]);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [tools, setTools] = useState<Record<string, HostMcpToolInfo[]>>({});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [inspecting, setInspecting] = useState<string | null>(null);

  const reload = async () => {
    setConnections(await host.listMcpConnections());
    setLoading(false);
  };

  useEffect(() => {
    void reload().catch((error) => {
      setLoading(false);
      notifyUnknownError(error);
    });
  }, []);

  useEffect(() => {
    if (!connections.some((connection) => connection.status?.state === "refreshing")) return;
    const timer = window.setTimeout(() => {
      void reload().catch(notifyUnknownError);
    }, 1_000);
    return () => window.clearTimeout(timer);
  }, [connections]);

  const updateDraft = <K extends keyof Draft>(key: K, value: Draft[K]) => {
    setDraft((current) => (current ? { ...current, [key]: value } : current));
  };

  const mutationFor = (value: Draft): HostMcpConnectionMutation =>
    value.kind === "stdio"
      ? {
          id: value.id.trim(),
          label: value.label.trim(),
          enabled: value.enabled,
          commandApproved: true,
          transport: {
            kind: "stdio",
            command: value.command.trim(),
            args: value.argumentsText
              .split(/\r?\n/u)
              .map((argument) => argument.trim())
              .filter(Boolean),
            ...(value.cwd.trim() ? { cwd: value.cwd.trim() } : {}),
            ...(parseEnvironment(value.environmentText)
              ? { env: parseEnvironment(value.environmentText) }
              : {}),
          },
        }
      : {
          id: value.id.trim(),
          label: value.label.trim(),
          enabled: value.enabled,
          transport: {
            kind: "http",
            url: value.url.trim(),
            ...(value.bearerToken.trim() ? { bearerToken: value.bearerToken.trim() } : {}),
          },
        };

  const save = async () => {
    if (!draft) return;
    setSaving(true);
    try {
      await host.upsertMcpConnection(mutationFor(draft));
      await reload();
      setDraft(null);
      notifySuccess(t("mcp.saved"));
    } catch (error) {
      notifyUnknownError(error);
    } finally {
      setSaving(false);
    }
  };

  const toggle = async (connection: HostMcpConnection, enabled: boolean) => {
    const next = draftFor(connection);
    next.enabled = enabled;
    next.commandApproved = true;
    try {
      await host.upsertMcpConnection(mutationFor(next));
      await reload();
    } catch (error) {
      notifyUnknownError(error);
    }
  };

  const inspect = async (connection: HostMcpConnection) => {
    setInspecting(connection.id);
    try {
      const result = await host.inspectMcpConnection(connection.id);
      setTools((current) => ({ ...current, [connection.id]: result }));
      await reload();
    } catch (error) {
      notifyUnknownError(error);
      await reload().catch(() => undefined);
    } finally {
      setInspecting(null);
    }
  };

  const remove = async (connection: HostMcpConnection) => {
    if (!window.confirm(t("mcp.removeConfirm", { name: connection.label }))) return;
    try {
      await host.removeMcpConnection(connection.id);
      await reload();
    } catch (error) {
      notifyUnknownError(error);
    }
  };

  if (loading) {
    return <p className="text-sm text-muted-foreground">{t("mcp.loading")}</p>;
  }

  const canSave = Boolean(
    draft?.id.trim() &&
    draft.label.trim() &&
    (draft.kind === "http" ? draft.url.trim() : draft.command.trim() && draft.commandApproved),
  );
  const commandPreview = draft?.command.trim()
    ? [draft.command.trim(), ...draft.argumentsText.split(/\r?\n/u).filter(Boolean)].join(" ")
    : "";

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="max-w-2xl space-y-1">
          <p className="text-sm font-medium">{t("mcp.heading")}</p>
          <p className="text-sm text-muted-foreground">{t("mcp.description")}</p>
        </div>
        {!draft && (
          <Button type="button" size="sm" onClick={() => setDraft(emptyDraft())}>
            <Plus className="size-4" />
            {t("mcp.addConnection")}
          </Button>
        )}
      </div>

      {draft && (
        <section
          className="space-y-4 rounded-lg border bg-muted/20 p-4"
          aria-label={t("mcp.editor")}
        >
          <div className="flex items-center justify-between gap-3">
            <h3 className="text-sm font-semibold">{t("mcp.editor")}</h3>
            <Button type="button" variant="ghost" size="icon-sm" onClick={() => setDraft(null)}>
              <X className="size-4" />
              <span className="sr-only">{t("common.cancel")}</span>
            </Button>
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label={t("mcp.fields.label")} htmlFor="mcp-label">
              <Input
                id="mcp-label"
                value={draft.label}
                onChange={(event) => updateDraft("label", event.target.value)}
              />
            </Field>
            <Field label={t("mcp.fields.id")} htmlFor="mcp-id">
              <Input
                id="mcp-id"
                value={draft.id}
                disabled={connections.some((connection) => connection.id === draft.id)}
                onChange={(event) => updateDraft("id", event.target.value)}
              />
            </Field>
          </div>
          <fieldset className="space-y-2">
            <legend className="text-sm font-medium">{t("mcp.fields.transport")}</legend>
            <div className="flex gap-2">
              {(["stdio", "http"] as const).map((kind) => (
                <Button
                  key={kind}
                  type="button"
                  size="sm"
                  variant={draft.kind === kind ? "default" : "outline"}
                  onClick={() => updateDraft("kind", kind)}
                >
                  {t(`mcp.transport.${kind}`)}
                </Button>
              ))}
            </div>
          </fieldset>
          {draft.kind === "stdio" ? (
            <div className="space-y-4">
              <Field label={t("mcp.fields.command")} htmlFor="mcp-command">
                <Input
                  id="mcp-command"
                  value={draft.command}
                  onChange={(event) => {
                    updateDraft("command", event.target.value);
                    updateDraft("commandApproved", false);
                  }}
                />
              </Field>
              <div className="grid gap-4 sm:grid-cols-2">
                <Field label={t("mcp.fields.arguments")} htmlFor="mcp-arguments">
                  <textarea
                    id="mcp-arguments"
                    className="min-h-24 w-full rounded-lg border bg-transparent px-2.5 py-2 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
                    value={draft.argumentsText}
                    onChange={(event) => {
                      updateDraft("argumentsText", event.target.value);
                      updateDraft("commandApproved", false);
                    }}
                  />
                </Field>
                <Field label={t("mcp.fields.environment")} htmlFor="mcp-environment">
                  <textarea
                    id="mcp-environment"
                    className="min-h-24 w-full rounded-lg border bg-transparent px-2.5 py-2 font-mono text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
                    value={draft.environmentText}
                    placeholder="TOKEN=..."
                    onChange={(event) => updateDraft("environmentText", event.target.value)}
                  />
                </Field>
              </div>
              <Field label={t("mcp.fields.cwd")} htmlFor="mcp-cwd">
                <Input
                  id="mcp-cwd"
                  value={draft.cwd}
                  onChange={(event) => updateDraft("cwd", event.target.value)}
                />
              </Field>
              <div className="space-y-3 rounded-md border border-destructive/30 bg-destructive/5 p-3">
                <p className="text-sm font-medium text-destructive">{t("mcp.commandWarning")}</p>
                <code className="block overflow-x-auto rounded bg-background px-3 py-2 text-sm">
                  {commandPreview || t("mcp.commandPlaceholder")}
                </code>
                <label className="flex items-start gap-2 text-sm">
                  <input
                    type="checkbox"
                    className="mt-0.5 size-4"
                    checked={draft.commandApproved}
                    onChange={(event) => updateDraft("commandApproved", event.target.checked)}
                  />
                  <span>{t("mcp.commandApproval")}</span>
                </label>
              </div>
            </div>
          ) : (
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label={t("mcp.fields.url")} htmlFor="mcp-url">
                <Input
                  id="mcp-url"
                  type="url"
                  placeholder="https://example.com/mcp"
                  value={draft.url}
                  onChange={(event) => updateDraft("url", event.target.value)}
                />
              </Field>
              <Field label={t("mcp.fields.bearerToken")} htmlFor="mcp-token">
                <div className="space-y-1.5">
                  <Input
                    id="mcp-token"
                    type="password"
                    placeholder="sk_…"
                    value={draft.bearerToken}
                    onChange={(event) => updateDraft("bearerToken", event.target.value)}
                  />
                  <p className="text-xs text-muted-foreground">{t("mcp.bearerTokenHelp")}</p>
                </div>
              </Field>
            </div>
          )}
          <div className="flex justify-end gap-2 border-t pt-4">
            <Button type="button" variant="ghost" onClick={() => setDraft(null)}>
              {t("common.cancel")}
            </Button>
            <Button type="button" disabled={!canSave || saving} onClick={() => void save()}>
              {saving ? t("mcp.saving") : t("mcp.save")}
            </Button>
          </div>
        </section>
      )}

      {connections.length === 0 && !draft ? (
        <div className="flex min-h-40 flex-col items-center justify-center gap-2 border-y py-8 text-center">
          <Plug className="size-5 text-muted-foreground" />
          <p className="text-sm font-medium">{t("mcp.emptyTitle")}</p>
          <p className="max-w-md text-sm text-muted-foreground">{t("mcp.emptyDescription")}</p>
        </div>
      ) : (
        <div className="divide-y border-y">
          {connections.map((connection) => (
            <div key={connection.id} className="space-y-3 py-4">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <p className="font-medium">{connection.label}</p>
                    <Badge
                      variant={
                        connection.status?.state === "offline"
                          ? "destructive"
                          : connection.status?.state === "ready"
                            ? "secondary"
                            : "outline"
                      }
                    >
                      {t(
                        connection.status
                          ? `mcp.status.${connection.status.state}`
                          : connection.enabled
                            ? "mcp.enabled"
                            : "mcp.disabled",
                      )}
                    </Badge>
                    <Badge variant="outline">
                      {t(`mcp.transport.${connection.transport.kind}`)}
                    </Badge>
                  </div>
                  <p className="mt-1 truncate text-xs text-muted-foreground">{connection.id}</p>
                  {connection.status && (
                    <p
                      className={`mt-1 text-xs ${
                        connection.status.problem ? "text-destructive" : "text-muted-foreground"
                      }`}
                      role={connection.status.problem ? "status" : undefined}
                    >
                      {connection.status.problem
                        ? t(`mcp.problem.${connection.status.problem.code}`)
                        : t("mcp.toolCount", { count: connection.status.toolCount })}
                    </p>
                  )}
                </div>
                <div className="flex items-center gap-2">
                  <Switch
                    checked={connection.enabled}
                    aria-label={t("mcp.toggle", { name: connection.label })}
                    onCheckedChange={(checked) => void toggle(connection, checked)}
                  />
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    disabled={!connection.enabled || inspecting === connection.id}
                    onClick={() => void inspect(connection)}
                  >
                    <RefreshCw className="size-4" />
                    {inspecting === connection.id ? t("mcp.inspecting") : t("mcp.inspect")}
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    onClick={() => setDraft(draftFor(connection))}
                  >
                    {t("common.edit")}
                  </Button>
                  <Button
                    type="button"
                    size="icon-sm"
                    variant="ghost"
                    onClick={() => void remove(connection)}
                  >
                    <Trash2 className="size-4" />
                    <span className="sr-only">{t("common.remove")}</span>
                  </Button>
                </div>
              </div>
              {tools[connection.id] && (
                <div className="space-y-2 rounded-md bg-muted/40 p-3">
                  <p className="text-xs font-medium">
                    {t("mcp.toolCount", { count: (tools[connection.id] ?? []).length })}
                  </p>
                  <div className="flex flex-wrap gap-1.5">
                    {(tools[connection.id] ?? []).map((tool) => (
                      <Badge key={tool.name} variant="outline" title={tool.description}>
                        {tool.title || tool.name}
                      </Badge>
                    ))}
                  </div>
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
function Field({
  label,
  htmlFor,
  children,
}: {
  label: string;
  htmlFor: string;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-2">
      <Label htmlFor={htmlFor}>{label}</Label>
      {children}
    </div>
  );
}
