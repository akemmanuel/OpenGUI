import {
  ArrowLeft,
  ChevronDown,
  Globe,
  Pencil,
  Plus,
  RefreshCw,
  ShieldAlert,
  Terminal,
  Trash2,
  X,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { getIdentityWorkspace } from "@/features/identity/workspace-identity";
import { notifySuccess, notifyUnknownError } from "@/lib/notify";
import { cn } from "@/lib/utils";
import { createHostClient } from "@/protocol/host-client";
import type {
  HostMcpConnection,
  HostMcpConnectionMutation,
  HostMcpConnectionStatus,
  HostMcpToolInfo,
} from "@/protocol/host-types";
import {
  connectionIdFrom,
  formatCommandLine,
  parseMcpInput,
  tokenizeCommandLine,
  type EnvironmentRow,
} from "./mcp-input";

type Draft = {
  /** Set when editing a saved connection; its id cannot change. */
  existingId: string | null;
  id: string;
  idEdited: boolean;
  label: string;
  enabled: boolean;
  kind: "stdio" | "http";
  url: string;
  bearerToken: string;
  hasSavedToken: boolean;
  commandLine: string;
  approvedCommandLine: string | null;
  cwd: string;
  env: EnvironmentRow[];
  savedEnvKeys: string[];
  replaceEnv: boolean;
};

type Editor = { step: "paste"; input: string; error: boolean } | { step: "review"; draft: Draft };

const EXAMPLES = [
  "https://mcp.example.com/mcp",
  "npx -y @modelcontextprotocol/server-filesystem ~/Documents",
];

function draftFor(connection: HostMcpConnection): Draft {
  const base: Draft = {
    existingId: connection.id,
    id: connection.id,
    idEdited: true,
    label: connection.label,
    enabled: connection.enabled,
    kind: connection.transport.kind,
    url: "",
    bearerToken: "",
    hasSavedToken: false,
    commandLine: "",
    approvedCommandLine: null,
    cwd: "",
    env: [],
    savedEnvKeys: [],
    replaceEnv: false,
  };
  if (connection.transport.kind === "http") {
    return {
      ...base,
      url: connection.transport.url,
      hasSavedToken: connection.transport.bearerTokenConfigured,
    };
  }
  const commandLine = formatCommandLine(connection.transport.command, connection.transport.args);
  return {
    ...base,
    commandLine,
    // The saved command was approved when it was added; only a change needs approval again.
    approvedCommandLine: commandLine,
    cwd: connection.transport.cwd ?? "",
    savedEnvKeys: connection.transport.envKeys,
  };
}

function mutationFor(draft: Draft): HostMcpConnectionMutation {
  const common = { id: draft.id.trim(), label: draft.label.trim(), enabled: draft.enabled };
  if (draft.kind === "http") {
    return {
      ...common,
      transport: {
        kind: "http",
        url: draft.url.trim(),
        ...(draft.bearerToken.trim() ? { bearerToken: draft.bearerToken.trim() } : {}),
      },
    };
  }
  const [command = "", ...args] = tokenizeCommandLine(draft.commandLine);
  const editingEnv = draft.savedEnvKeys.length === 0 || draft.replaceEnv;
  const env = Object.fromEntries(
    draft.env
      .map((row) => [row.key.trim(), row.value] as const)
      .filter(([key, value]) => key && value),
  );
  return {
    ...common,
    commandApproved: true,
    transport: {
      kind: "stdio",
      command,
      args,
      ...(draft.cwd.trim() ? { cwd: draft.cwd.trim() } : {}),
      // Omitting env keeps the saved secrets; sending it replaces all of them.
      ...(editingEnv && (draft.replaceEnv || Object.keys(env).length > 0) ? { env } : {}),
    },
  };
}

function connectionSummary(connection: HostMcpConnection) {
  if (connection.transport.kind === "http") {
    try {
      const url = new URL(connection.transport.url);
      return `${url.host}${url.pathname === "/" ? "" : url.pathname}`;
    } catch {
      return connection.transport.url;
    }
  }
  return formatCommandLine(connection.transport.command, connection.transport.args);
}

type StatusTone = "ready" | "busy" | "warning" | "error" | "off" | "unknown";

function statusTone(connection: HostMcpConnection): StatusTone {
  if (!connection.enabled) return "off";
  switch (connection.status?.state) {
    case "ready":
      return "ready";
    case "refreshing":
      return "busy";
    case "degraded":
      return "warning";
    case "offline":
      return "error";
    case "disabled":
      return "off";
    default:
      return "unknown";
  }
}

const TONE_DOT: Record<StatusTone, string> = {
  ready: "bg-emerald-500",
  busy: "bg-muted-foreground motion-safe:animate-pulse",
  warning: "bg-amber-500",
  error: "bg-destructive",
  off: "bg-muted-foreground/40",
  unknown: "border border-muted-foreground bg-transparent",
};

const TONE_TEXT: Record<StatusTone, string> = {
  ready: "text-emerald-700 dark:text-emerald-400",
  busy: "text-muted-foreground",
  warning: "text-amber-700 dark:text-amber-400",
  error: "text-destructive",
  off: "text-muted-foreground",
  unknown: "text-muted-foreground",
};

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
  const [editor, setEditor] = useState<Editor | null>(null);
  const [tools, setTools] = useState<Record<string, HostMcpToolInfo[]>>({});
  const [expanded, setExpanded] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState<string | null>(null);
  const [removing, setRemoving] = useState<HostMcpConnection | null>(null);

  const reload = async () => {
    const next = await host.listMcpConnections();
    setConnections(next);
    setLoading(false);
    return next;
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

  const test = async (id: string) => {
    setTesting(id);
    try {
      const result = await host.inspectMcpConnection(id);
      setTools((current) => ({ ...current, [id]: result }));
      await reload();
      return result;
    } catch (error) {
      await reload().catch(() => undefined);
      throw error;
    } finally {
      setTesting(null);
    }
  };

  const save = async (draft: Draft) => {
    setSaving(true);
    try {
      const saved = await host.upsertMcpConnection(mutationFor(draft));
      await reload();
      setEditor(null);
      setExpanded(saved.id);
      if (!saved.enabled) {
        notifySuccess(t("mcp.saved"));
        return;
      }
      try {
        const found = await test(saved.id);
        notifySuccess(t("mcp.connected", { name: saved.label, count: found.length }));
      } catch {
        // The row shows the problem and how to fix it.
      }
    } catch (error) {
      notifyUnknownError(error);
    } finally {
      setSaving(false);
    }
  };

  const toggle = async (connection: HostMcpConnection, enabled: boolean) => {
    const draft = draftFor(connection);
    try {
      await host.upsertMcpConnection(mutationFor({ ...draft, enabled }));
      await reload();
    } catch (error) {
      notifyUnknownError(error);
    }
  };

  const remove = async (connection: HostMcpConnection) => {
    try {
      await host.removeMcpConnection(connection.id);
      if (expanded === connection.id) setExpanded(null);
      await reload();
    } catch (error) {
      notifyUnknownError(error);
    }
  };

  if (loading) {
    return (
      <div className="space-y-3" role="status" aria-label={t("mcp.loading")}>
        <Skeleton className="h-16 w-full" />
        <Skeleton className="h-16 w-full" />
      </div>
    );
  }

  const empty = connections.length === 0;
  const activeEditor: Editor | null =
    editor ?? (empty ? { step: "paste", input: "", error: false } : null);

  return (
    <div className="space-y-6">
      {activeEditor ? (
        <ConnectionEditor
          key={activeEditor.step === "review" ? (activeEditor.draft.existingId ?? "new") : "paste"}
          editor={activeEditor}
          takenIds={connections.map((connection) => connection.id)}
          saving={saving}
          cancellable={!empty || editor?.step === "review"}
          onChange={setEditor}
          onCancel={() => setEditor(null)}
          onSave={(draft) => void save(draft)}
        />
      ) : (
        <div className="flex justify-end">
          <Button
            type="button"
            size="sm"
            onClick={() => setEditor({ step: "paste", input: "", error: false })}
          >
            <Plus className="size-4" />
            {t("mcp.addConnection")}
          </Button>
        </div>
      )}

      {!empty && (
        <ul className="divide-y rounded-lg border" aria-label={t("mcp.heading")}>
          {connections.map((connection) => (
            <ConnectionRow
              key={connection.id}
              connection={connection}
              tools={tools[connection.id]}
              expanded={expanded === connection.id}
              testing={testing === connection.id}
              onExpand={(open) => setExpanded(open ? connection.id : null)}
              onToggle={(enabled) => void toggle(connection, enabled)}
              onTest={() => void test(connection.id).catch(notifyUnknownError)}
              onEdit={() => setEditor({ step: "review", draft: draftFor(connection) })}
              onRemove={() => setRemoving(connection)}
            />
          ))}
        </ul>
      )}

      <AlertDialog
        open={removing !== null}
        onOpenChange={(open) => {
          if (!open) setRemoving(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {t("mcp.removeTitle", { name: removing?.label ?? "" })}
            </AlertDialogTitle>
            <AlertDialogDescription>{t("mcp.removeHelp")}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("common.cancel")}</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={() => {
                if (removing) void remove(removing);
                setRemoving(null);
              }}
            >
              {t("common.remove")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

function ConnectionEditor({
  editor,
  takenIds,
  saving,
  cancellable,
  onChange,
  onCancel,
  onSave,
}: {
  editor: Editor;
  takenIds: string[];
  saving: boolean;
  cancellable: boolean;
  onChange: (editor: Editor) => void;
  onCancel: () => void;
  onSave: (draft: Draft) => void;
}) {
  const { t } = useTranslation();
  const pasteRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (editor.step === "paste" && cancellable) pasteRef.current?.focus();
  }, [editor.step, cancellable]);

  if (editor.step === "paste") {
    const submit = (event: FormEvent) => {
      event.preventDefault();
      const parsed = parseMcpInput(editor.input);
      if (!parsed) {
        onChange({ ...editor, error: true });
        return;
      }
      const label = parsed.label || t("mcp.defaultName");
      onChange({
        step: "review",
        draft: {
          existingId: null,
          id: connectionIdFrom(label, takenIds),
          idEdited: false,
          label,
          enabled: true,
          kind: parsed.kind,
          url: parsed.kind === "http" ? parsed.url : "",
          bearerToken: "",
          hasSavedToken: false,
          commandLine: parsed.kind === "stdio" ? parsed.commandLine : "",
          approvedCommandLine: null,
          cwd: "",
          env: parsed.kind === "stdio" ? parsed.env : [],
          savedEnvKeys: [],
          replaceEnv: false,
        },
      });
    };
    return (
      <form
        onSubmit={submit}
        aria-label={t("mcp.addTitle")}
        className="space-y-4 rounded-lg border bg-muted/30 p-4 sm:p-5"
      >
        <div className="flex items-start justify-between gap-3">
          <div className="space-y-1">
            <h3 className="text-base font-semibold">{t("mcp.addTitle")}</h3>
            <p className="max-w-[60ch] text-sm text-muted-foreground">{t("mcp.addHelp")}</p>
          </div>
          {cancellable && (
            <Button type="button" variant="ghost" size="icon-sm" onClick={onCancel}>
              <X className="size-4" />
              <span className="sr-only">{t("common.cancel")}</span>
            </Button>
          )}
        </div>
        <div className="space-y-2">
          <Label htmlFor="mcp-paste">{t("mcp.paste.label")}</Label>
          <div className="flex flex-col gap-2 sm:flex-row">
            <Input
              ref={pasteRef}
              id="mcp-paste"
              value={editor.input}
              autoComplete="off"
              spellCheck={false}
              placeholder={t("mcp.paste.placeholder")}
              aria-invalid={editor.error || undefined}
              aria-describedby="mcp-paste-help"
              className="h-10 font-mono text-sm"
              onChange={(event) =>
                onChange({ step: "paste", input: event.target.value, error: false })
              }
            />
            <Button type="submit" className="h-10" disabled={!editor.input.trim()}>
              {t("mcp.paste.continue")}
            </Button>
          </div>
          <p
            id="mcp-paste-help"
            className={cn("text-xs", editor.error ? "text-destructive" : "text-muted-foreground")}
            role={editor.error ? "alert" : undefined}
          >
            {editor.error ? t("mcp.paste.unrecognized") : t("mcp.paste.help")}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
          <span>{t("mcp.paste.examples")}</span>
          {EXAMPLES.map((example) => (
            <Button
              key={example}
              type="button"
              variant="outline"
              size="xs"
              className="max-w-full truncate font-mono font-normal"
              onClick={() => {
                onChange({ step: "paste", input: example, error: false });
                pasteRef.current?.focus();
              }}
            >
              {example}
            </Button>
          ))}
        </div>
      </form>
    );
  }

  return (
    <ReviewForm
      draft={editor.draft}
      takenIds={takenIds}
      saving={saving}
      onChange={(draft) => onChange({ step: "review", draft })}
      onBack={
        editor.draft.existingId
          ? null
          : () =>
              onChange({
                step: "paste",
                input: editor.draft.kind === "http" ? editor.draft.url : editor.draft.commandLine,
                error: false,
              })
      }
      onCancel={onCancel}
      onSave={onSave}
    />
  );
}

function ReviewForm({
  draft,
  takenIds,
  saving,
  onChange,
  onBack,
  onCancel,
  onSave,
}: {
  draft: Draft;
  takenIds: string[];
  saving: boolean;
  onChange: (draft: Draft) => void;
  onBack: (() => void) | null;
  onCancel: () => void;
  onSave: (draft: Draft) => void;
}) {
  const { t } = useTranslation();
  const [advanced, setAdvanced] = useState(false);
  const editing = draft.existingId !== null;
  const set = <K extends keyof Draft>(key: K, value: Draft[K]) =>
    onChange({ ...draft, [key]: value });
  const trusted =
    draft.kind === "http" ||
    (draft.approvedCommandLine !== null && draft.approvedCommandLine === draft.commandLine);
  const idTaken = !editing && takenIds.includes(draft.id.trim());
  const idValid = /^[a-zA-Z0-9._-]{1,64}$/u.test(draft.id.trim()) && !idTaken;
  const canSave = Boolean(
    draft.label.trim() &&
    idValid &&
    trusted &&
    (draft.kind === "http" ? draft.url.trim() : tokenizeCommandLine(draft.commandLine).length > 0),
  );
  const editingEnv = draft.savedEnvKeys.length === 0 || draft.replaceEnv;
  const Icon = draft.kind === "http" ? Globe : Terminal;

  return (
    <form
      aria-label={editing ? t("mcp.editTitle", { name: draft.label }) : t("mcp.addTitle")}
      className="space-y-5 rounded-lg border bg-muted/30 p-4 sm:p-5"
      onSubmit={(event) => {
        event.preventDefault();
        if (canSave && !saving) onSave(draft);
      }}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 items-center gap-3">
          {onBack && (
            <Button type="button" variant="ghost" size="icon-sm" onClick={onBack}>
              <ArrowLeft className="size-4" />
              <span className="sr-only">{t("common.back")}</span>
            </Button>
          )}
          <div className="min-w-0">
            <h3 className="truncate text-base font-semibold">
              {editing ? t("mcp.editTitle", { name: draft.label }) : t("mcp.reviewTitle")}
            </h3>
            <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <Icon className="size-3.5" aria-hidden="true" />
              {t(`mcp.transport.${draft.kind}`)}
            </p>
          </div>
        </div>
        <Button type="button" variant="ghost" size="icon-sm" onClick={onCancel}>
          <X className="size-4" />
          <span className="sr-only">{t("common.cancel")}</span>
        </Button>
      </div>

      <div className="grid gap-4">
        <Field label={t("mcp.fields.label")} htmlFor="mcp-label" className="sm:max-w-sm">
          <Input
            id="mcp-label"
            value={draft.label}
            onChange={(event) => {
              const label = event.target.value;
              onChange({
                ...draft,
                label,
                ...(draft.idEdited ? {} : { id: connectionIdFrom(label, takenIds) }),
              });
            }}
          />
        </Field>
        {draft.kind === "http" ? (
          <Field label={t("mcp.fields.url")} htmlFor="mcp-url">
            <Input
              id="mcp-url"
              type="url"
              spellCheck={false}
              className="font-mono text-sm"
              placeholder="https://example.com/mcp"
              value={draft.url}
              onChange={(event) => set("url", event.target.value)}
            />
          </Field>
        ) : (
          <Field label={t("mcp.fields.commandLine")} htmlFor="mcp-command">
            <Input
              id="mcp-command"
              spellCheck={false}
              className="font-mono text-sm"
              value={draft.commandLine}
              onChange={(event) => set("commandLine", event.target.value)}
            />
          </Field>
        )}
      </div>

      {draft.kind === "http" ? (
        <Field label={t("mcp.fields.bearerToken")} htmlFor="mcp-token">
          <Input
            id="mcp-token"
            type="password"
            autoComplete="off"
            placeholder={draft.hasSavedToken ? t("mcp.tokenSavedPlaceholder") : "sk_…"}
            value={draft.bearerToken}
            onChange={(event) => set("bearerToken", event.target.value)}
          />
          <p className="text-xs text-muted-foreground">
            {draft.hasSavedToken ? t("mcp.tokenSavedHelp") : t("mcp.bearerTokenHelp")}
          </p>
        </Field>
      ) : (
        <>
          <fieldset className="space-y-2">
            <legend className="text-sm font-medium">{t("mcp.fields.environment")}</legend>
            <p className="text-xs text-muted-foreground">{t("mcp.envHelp")}</p>
            {editingEnv ? (
              <EnvironmentEditor rows={draft.env} onChange={(env) => set("env", env)} />
            ) : (
              <div className="flex flex-wrap items-center gap-2 rounded-md border border-dashed px-3 py-2 text-sm">
                <span className="min-w-0 flex-1 font-mono text-xs [overflow-wrap:anywhere]">
                  {t("mcp.envSaved", { keys: draft.savedEnvKeys.join(", ") })}
                </span>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={() =>
                    onChange({
                      ...draft,
                      replaceEnv: true,
                      env: draft.savedEnvKeys.map((key) => ({ key, value: "" })),
                    })
                  }
                >
                  {t("mcp.envReplace")}
                </Button>
              </div>
            )}
          </fieldset>
          <label
            className={cn(
              "flex items-start gap-3 rounded-md border p-3 text-sm transition-colors",
              trusted ? "border-border bg-background" : "border-amber-500/40 bg-amber-500/5",
            )}
          >
            <Checkbox
              className="mt-0.5 bg-background"
              checked={trusted}
              onCheckedChange={(checked) =>
                set("approvedCommandLine", checked ? draft.commandLine : null)
              }
            />
            <span className="space-y-1">
              <span className="flex items-center gap-1.5 font-medium">
                <ShieldAlert
                  className="size-4 text-amber-600 dark:text-amber-400"
                  aria-hidden="true"
                />
                {t("mcp.commandApproval")}
              </span>
              <span className="block text-xs text-muted-foreground">{t("mcp.commandWarning")}</span>
            </span>
          </label>
        </>
      )}

      <Collapsible open={advanced || !idValid} onOpenChange={setAdvanced} className="space-y-4">
        <CollapsibleTrigger
          render={
            <Button
              type="button"
              variant="ghost"
              size="xs"
              className="group/advanced -ml-2 text-muted-foreground"
            />
          }
        >
          <ChevronDown
            className="-rotate-90 transition-transform group-data-[panel-open]/advanced:rotate-0"
            aria-hidden="true"
          />
          {t("mcp.advanced")}
        </CollapsibleTrigger>
        <CollapsibleContent className="grid gap-4 sm:grid-cols-2">
          <Field label={t("mcp.fields.id")} htmlFor="mcp-id">
            <Input
              id="mcp-id"
              value={draft.id}
              disabled={editing}
              spellCheck={false}
              className="font-mono text-sm"
              aria-invalid={!idValid || undefined}
              onChange={(event) => onChange({ ...draft, id: event.target.value, idEdited: true })}
            />
            <p className={cn("text-xs", idValid ? "text-muted-foreground" : "text-destructive")}>
              {idTaken ? t("mcp.idTaken") : t("mcp.idHelp")}
            </p>
          </Field>
          {draft.kind === "stdio" && (
            <Field label={t("mcp.fields.cwd")} htmlFor="mcp-cwd">
              <Input
                id="mcp-cwd"
                spellCheck={false}
                className="font-mono text-sm"
                value={draft.cwd}
                onChange={(event) => set("cwd", event.target.value)}
              />
            </Field>
          )}
        </CollapsibleContent>
      </Collapsible>

      <div className="flex flex-wrap items-center justify-end gap-2 border-t pt-4">
        <Button type="button" variant="ghost" onClick={onCancel}>
          {t("common.cancel")}
        </Button>
        <Button type="submit" disabled={!canSave || saving}>
          {saving ? t("mcp.saving") : editing ? t("mcp.saveChanges") : t("mcp.save")}
        </Button>
      </div>
    </form>
  );
}

function EnvironmentEditor({
  rows,
  onChange,
}: {
  rows: EnvironmentRow[];
  onChange: (rows: EnvironmentRow[]) => void;
}) {
  const { t } = useTranslation();
  const update = (index: number, patch: Partial<EnvironmentRow>) =>
    onChange(rows.map((row, current) => (current === index ? { ...row, ...patch } : row)));
  return (
    <div className="space-y-2">
      {rows.map((row, index) => (
        <div key={index} className="grid grid-cols-[minmax(0,2fr)_minmax(0,3fr)_auto] gap-2">
          <Input
            aria-label={t("mcp.variableName")}
            placeholder="API_KEY"
            spellCheck={false}
            autoComplete="off"
            className="font-mono text-sm"
            value={row.key}
            onChange={(event) =>
              update(index, { key: event.target.value.replace(/[^A-Za-z0-9_]/gu, "_") })
            }
          />
          <Input
            aria-label={t("mcp.variableValue", { name: row.key || "API_KEY" })}
            type="password"
            autoComplete="off"
            placeholder={t("mcp.variableValuePlaceholder")}
            value={row.value}
            onChange={(event) => update(index, { value: event.target.value })}
          />
          <Button
            type="button"
            variant="ghost"
            size="icon"
            onClick={() => onChange(rows.filter((_, current) => current !== index))}
          >
            <X className="size-4" />
            <span className="sr-only">{t("mcp.removeVariable", { name: row.key })}</span>
          </Button>
        </div>
      ))}
      <Button
        type="button"
        variant="outline"
        size="sm"
        onClick={() => onChange([...rows, { key: "", value: "" }])}
      >
        <Plus className="size-4" />
        {t("mcp.addVariable")}
      </Button>
    </div>
  );
}

function statusLabel(
  t: (key: string, options?: Record<string, unknown>) => string,
  connection: HostMcpConnection,
) {
  const status: HostMcpConnectionStatus | undefined = connection.status;
  if (!connection.enabled) return t("mcp.status.disabled");
  if (!status) return t("mcp.status.unchecked");
  if (status.state === "ready" || status.state === "degraded") {
    return status.state === "ready"
      ? t("mcp.toolCount", { count: status.toolCount })
      : t("mcp.status.degraded");
  }
  return t(`mcp.status.${status.state}`);
}

function ConnectionRow({
  connection,
  tools,
  expanded,
  testing,
  onExpand,
  onToggle,
  onTest,
  onEdit,
  onRemove,
}: {
  connection: HostMcpConnection;
  tools: HostMcpToolInfo[] | undefined;
  expanded: boolean;
  testing: boolean;
  onExpand: (open: boolean) => void;
  onToggle: (enabled: boolean) => void;
  onTest: () => void;
  onEdit: () => void;
  onRemove: () => void;
}) {
  const { t } = useTranslation();
  const tone = testing ? "busy" : statusTone(connection);
  const problem = connection.enabled ? connection.status?.problem : undefined;
  const Icon = connection.transport.kind === "http" ? Globe : Terminal;

  return (
    <Collapsible
      open={expanded}
      onOpenChange={onExpand}
      render={<li className={cn("transition-colors", expanded && "bg-muted/25")} />}
    >
      <div className="flex items-center gap-3 px-3 py-3 sm:px-4">
        <CollapsibleTrigger className="-m-1.5 flex min-w-0 flex-1 flex-wrap items-center gap-x-3 gap-y-1 rounded-md p-1.5 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
          <span
            className="flex size-9 shrink-0 items-center justify-center rounded-md border bg-background text-muted-foreground"
            aria-hidden="true"
          >
            <Icon className="size-4" />
          </span>
          <span className="min-w-0 flex-1">
            <span className="block truncate text-sm font-medium">{connection.label}</span>
            <span className="block truncate font-mono text-xs text-muted-foreground">
              {connectionSummary(connection)}
            </span>
          </span>
          <span
            className={cn(
              "order-last flex w-full items-center gap-2 pl-12 text-xs sm:order-none sm:w-auto sm:pl-0",
              TONE_TEXT[tone],
            )}
          >
            <span
              className={cn("size-2 shrink-0 rounded-full", TONE_DOT[tone])}
              aria-hidden="true"
            />
            {testing ? t("mcp.inspecting") : statusLabel(t, connection)}
          </span>
          <ChevronDown
            className={cn(
              "size-4 shrink-0 text-muted-foreground transition-transform",
              expanded ? "" : "-rotate-90",
            )}
            aria-hidden="true"
          />
        </CollapsibleTrigger>
        <Switch
          checked={connection.enabled}
          aria-label={t("mcp.toggle", { name: connection.label })}
          onCheckedChange={onToggle}
        />
      </div>
      {problem && (
        <div
          role="status"
          className="mx-3 mb-3 flex flex-wrap items-center gap-x-3 gap-y-2 rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive sm:mx-4"
        >
          <span className="min-w-0 flex-1">{t(`mcp.problem.${problem.code}`)}</span>
          {problem.code === "authentication" ? (
            <Button type="button" size="sm" variant="outline" onClick={onEdit}>
              {t("mcp.updateCredentials")}
            </Button>
          ) : (
            <Button type="button" size="sm" variant="outline" disabled={testing} onClick={onTest}>
              {t("mcp.retry")}
            </Button>
          )}
        </div>
      )}
      <CollapsibleContent className="space-y-4 border-t px-3 py-4 sm:px-4">
        <section className="space-y-2" aria-label={t("mcp.toolsHeading")}>
          <div className="flex items-center justify-between gap-3">
            <h4 className="text-sm font-medium">{t("mcp.toolsHeading")}</h4>
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={!connection.enabled || testing}
              onClick={onTest}
            >
              <RefreshCw className={cn("size-4", testing && "motion-safe:animate-spin")} />
              {testing ? t("mcp.inspecting") : t("mcp.inspect")}
            </Button>
          </div>
          {!connection.enabled ? (
            <p className="text-sm text-muted-foreground">{t("mcp.enableToSeeTools")}</p>
          ) : tools ? (
            tools.length === 0 ? (
              <p className="text-sm text-muted-foreground">{t("mcp.noTools")}</p>
            ) : (
              <ul className="grid gap-x-6 gap-y-2 sm:grid-cols-2">
                {tools.map((tool) => (
                  <li key={tool.name} className="min-w-0">
                    <p className="truncate font-mono text-xs font-medium">
                      {tool.title || tool.name}
                    </p>
                    {tool.description && (
                      <p
                        className="line-clamp-2 text-xs text-muted-foreground"
                        title={tool.description}
                      >
                        {tool.description}
                      </p>
                    )}
                  </li>
                ))}
              </ul>
            )
          ) : (
            <p className="text-sm text-muted-foreground">{t("mcp.toolsHint")}</p>
          )}
        </section>
        <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1.5 text-xs">
          <dt className="text-muted-foreground">{t("mcp.fields.transport")}</dt>
          <dd>{t(`mcp.transport.${connection.transport.kind}`)}</dd>
          <dt className="text-muted-foreground">
            {connection.transport.kind === "http"
              ? t("mcp.fields.url")
              : t("mcp.fields.commandLine")}
          </dt>
          <dd className="font-mono [overflow-wrap:anywhere]">
            {connection.transport.kind === "http"
              ? connection.transport.url
              : formatCommandLine(connection.transport.command, connection.transport.args)}
          </dd>
          {connection.transport.kind === "stdio" && connection.transport.envKeys.length > 0 && (
            <>
              <dt className="text-muted-foreground">{t("mcp.fields.environment")}</dt>
              <dd className="font-mono [overflow-wrap:anywhere]">
                {connection.transport.envKeys.join(", ")}
              </dd>
            </>
          )}
          {connection.transport.kind === "http" && (
            <>
              <dt className="text-muted-foreground">{t("mcp.tokenLabel")}</dt>
              <dd>
                {connection.transport.bearerTokenConfigured
                  ? t("mcp.tokenSaved")
                  : t("mcp.tokenNone")}
              </dd>
            </>
          )}
          <dt className="text-muted-foreground">{t("mcp.fields.id")}</dt>
          <dd className="font-mono">{connection.id}</dd>
        </dl>
        <div className="flex flex-wrap gap-2">
          <Button type="button" size="sm" variant="outline" onClick={onEdit}>
            <Pencil className="size-4" />
            {t("common.edit")}
          </Button>
          <Button
            type="button"
            size="sm"
            variant="ghost"
            className="text-destructive hover:bg-destructive/10 hover:text-destructive"
            onClick={onRemove}
          >
            <Trash2 className="size-4" />
            {t("common.remove")}
          </Button>
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}

function Field({
  label,
  htmlFor,
  className,
  children,
}: {
  label: string;
  htmlFor: string;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <div className={cn("min-w-0 space-y-2", className)}>
      <Label htmlFor={htmlFor}>{label}</Label>
      {children}
    </div>
  );
}
