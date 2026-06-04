import { AlertCircle, CheckCircle2, Globe, Terminal } from "lucide-react";
import type { McpStatus } from "@opencode-ai/sdk/v2/client";
import { useCallback, useEffect, useState } from "react";
import { HARNESS_LABELS, type HarnessId } from "@/agents";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { Switch } from "@/components/ui/switch";
import { useConnectionState } from "@/hooks/use-agent-state";
import { useHarness, useAvailableHarnessIds, useCurrentHarnessId } from "@/hooks/use-agent-backend";

// ---------------------------------------------------------------------------
// MCP/Tools tab content (inline)
// ---------------------------------------------------------------------------

export function McpTabContent() {
  const initialBackendId = useCurrentHarnessId();
  const availableBackendIds = useAvailableHarnessIds();
  const [harnessId, setBackendId] = useState<HarnessId>(initialBackendId);
  const backend = useHarness(harnessId);
  const mcpApi = backend?.platform?.mcp;
  const configApi = backend?.platform?.config;
  const { activeDirectory, activeWorkspaceId } = useConnectionState();
  const scopedDirectory = activeDirectory ?? undefined;

  const [mcpStatus, setMcpStatus] = useState<{ [key: string]: McpStatus }>({});
  const [mcpTypes, setMcpTypes] = useState<{
    [key: string]: "local" | "remote";
  }>({});
  const [loading, setLoading] = useState(true);
  const [toggling, setToggling] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!mcpApi || !configApi) return;
    const target = { directory: scopedDirectory, workspaceId: activeWorkspaceId };
    const [statusData, configData] = await Promise.all([
      mcpApi.status(target),
      configApi.get(target),
    ]);
    setMcpStatus(statusData);
    if (configData?.mcp) {
      const types: { [key: string]: "local" | "remote" } = {};
      for (const [name, cfg] of Object.entries(configData.mcp)) {
        if (cfg && typeof cfg === "object" && "type" in cfg) {
          types[name] = (cfg as { type: "local" | "remote" }).type;
        }
      }
      setMcpTypes(types);
    }
    setLoading(false);
  }, [mcpApi, configApi, scopedDirectory, activeWorkspaceId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const handleToggle = async (name: string, currentStatus: McpStatus) => {
    if (!mcpApi) return;
    setToggling(name);
    try {
      if (currentStatus.status === "connected") {
        await mcpApi.disconnect(
          { directory: scopedDirectory, workspaceId: activeWorkspaceId },
          name,
        );
      } else {
        await mcpApi.connect({ directory: scopedDirectory, workspaceId: activeWorkspaceId }, name);
      }
      await new Promise((r) => setTimeout(r, 500));
      await refresh();
    } finally {
      setToggling(null);
    }
  };

  const STATUS_CONFIG = {
    connected: {
      variant: "default" as const,
      label: "Connected",
      icon: CheckCircle2,
      className: "bg-emerald-600 hover:bg-emerald-600",
    },
    disabled: { variant: "secondary" as const, label: "Disabled" },
    failed: {
      variant: "destructive" as const,
      label: "Failed",
      icon: AlertCircle,
    },
    needs_auth: {
      variant: "outline" as const,
      label: "Needs auth",
      className: "text-amber-500 border-amber-500",
    },
    needs_client_registration: {
      variant: "outline" as const,
      label: "Needs registration",
      className: "text-amber-500 border-amber-500",
    },
  } as const;

  const entries = Object.entries(mcpStatus).sort(([a], [b]) => a.localeCompare(b));

  if (loading) {
    return (
      <div className="flex items-center justify-center py-8">
        <Spinner className="size-5" />
      </div>
    );
  }

  return (
    <div className="space-y-2">
      {availableBackendIds.length > 1 && (
        <div className="mb-3 flex flex-wrap gap-1">
          {availableBackendIds.map((id) => (
            <Button
              key={id}
              type="button"
              variant={harnessId === id ? "default" : "outline"}
              size="sm"
              className="h-7 px-2 text-[11px]"
              onClick={() => setBackendId(id)}
            >
              {HARNESS_LABELS[id]}
            </Button>
          ))}
        </div>
      )}
      {entries.length === 0 ? (
        <div className="text-center py-6 text-sm text-muted-foreground">
          No MCP servers configured.
        </div>
      ) : (
        entries.map(([name, status]) => {
          const isConnected = status.status === "connected";
          const isToggling = toggling === name;
          const type = mcpTypes[name];
          const config = STATUS_CONFIG[status.status as keyof typeof STATUS_CONFIG] ?? {
            variant: "secondary" as const,
            label: "Unknown",
          };
          const BadgeIcon = "icon" in config ? config.icon : undefined;

          return (
            <div key={name} className="flex items-center gap-3 rounded-lg border p-3 bg-card">
              <div className="shrink-0 text-muted-foreground">
                {type === "remote" ? <Globe className="size-4" /> : <Terminal className="size-4" />}
              </div>
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <span className="text-sm font-medium font-mono truncate">{name}</span>
                  <Badge
                    variant={config.variant}
                    className={`text-xs${BadgeIcon ? " gap-1" : ""}${"className" in config ? ` ${config.className}` : ""}`}
                  >
                    {BadgeIcon && <BadgeIcon className="size-3" />}
                    {config.label}
                  </Badge>
                </div>
                {status.status === "failed" && "error" in status && (
                  <p className="text-[11px] text-destructive truncate mt-0.5">{status.error}</p>
                )}
              </div>
              <div className="flex items-center gap-1.5 shrink-0">
                {isToggling && <Spinner className="size-3.5" />}
                <Switch
                  checked={isConnected}
                  onCheckedChange={() => handleToggle(name, status)}
                  disabled={isToggling}
                />
              </div>
            </div>
          );
        })
      )}
    </div>
  );
}
