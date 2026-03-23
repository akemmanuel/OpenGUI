/**
 * Lightweight MCP server toggle dialog.
 *
 * Shows all MCP servers with their status and a switch to connect/disconnect.
 * No add, edit, or delete - purely runtime toggling.
 */

import type { McpStatus } from "@opencode-ai/sdk/v2/client";
import { AlertCircle, CheckCircle2, Globe, Terminal } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { Badge } from "@/components/ui/badge";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog";
import { Spinner } from "@/components/ui/spinner";
import { Switch } from "@/components/ui/switch";
import { MCP_TOGGLE_DELAY_MS } from "@/lib/constants";

// ---------------------------------------------------------------------------
// Status badge
// ---------------------------------------------------------------------------

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

function StatusBadge({ status }: { status: McpStatus }) {
	const config =
		STATUS_CONFIG[status.status as keyof typeof STATUS_CONFIG] ??
		({ variant: "secondary" as const, label: "Unknown" } as const);
	const Icon = "icon" in config ? config.icon : undefined;
	return (
		<Badge
			variant={config.variant}
			className={`text-xs${Icon ? " gap-1" : ""}${"className" in config ? ` ${config.className}` : ""}`}
		>
			{Icon && <Icon className="size-3" />}
			{config.label}
		</Badge>
	);
}

// ---------------------------------------------------------------------------
// Dialog
// ---------------------------------------------------------------------------

interface McpDialogProps {
	open: boolean;
	onOpenChange: (open: boolean) => void;
}

export function McpDialog({ open, onOpenChange }: McpDialogProps) {
	const bridge = window.electronAPI?.opencode;

	const [mcpStatus, setMcpStatus] = useState<Record<string, McpStatus>>({});
	const [mcpTypes, setMcpTypes] = useState<Record<string, "local" | "remote">>(
		{},
	);
	const [loading, setLoading] = useState(true);
	const [toggling, setToggling] = useState<string | null>(null);

	const refresh = useCallback(async () => {
		if (!bridge) return;
		const [statusRes, configRes] = await Promise.all([
			bridge.getMcpStatus(),
			bridge.getConfig(),
		]);
		if (statusRes.success && statusRes.data) {
			setMcpStatus(statusRes.data);
		}
		if (configRes.success && configRes.data?.mcp) {
			const types: Record<string, "local" | "remote"> = {};
			for (const [name, cfg] of Object.entries(configRes.data.mcp)) {
				if (cfg && typeof cfg === "object" && "type" in cfg) {
					types[name] = (cfg as { type: "local" | "remote" }).type;
				}
			}
			setMcpTypes(types);
		}
		setLoading(false);
	}, [bridge]);

	useEffect(() => {
		if (open) {
			setLoading(true);
			void refresh();
		}
	}, [open, refresh]);

	const handleToggle = async (name: string, currentStatus: McpStatus) => {
		if (!bridge) return;
		setToggling(name);
		try {
			if (currentStatus.status === "connected") {
				await bridge.disconnectMcp(name);
			} else {
				await bridge.connectMcp(name);
			}
			await new Promise((r) => setTimeout(r, MCP_TOGGLE_DELAY_MS));
			await refresh();
		} finally {
			setToggling(null);
		}
	};

	const entries = Object.entries(mcpStatus).sort(([a], [b]) =>
		a.localeCompare(b),
	);

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent className="sm:max-w-md max-h-[70vh] flex flex-col">
				<DialogHeader>
					<DialogTitle>Tools (MCP Servers)</DialogTitle>
					<DialogDescription>
						Toggle MCP servers on or off for this session.
					</DialogDescription>
				</DialogHeader>

				<div className="overflow-y-auto flex-1 space-y-2 pr-1">
					{loading ? (
						<div className="flex items-center justify-center py-8">
							<Spinner className="size-5" />
						</div>
					) : entries.length === 0 ? (
						<div className="text-center py-6 text-sm text-muted-foreground">
							No MCP servers configured.
						</div>
					) : (
						entries.map(([name, status]) => {
							const isConnected = status.status === "connected";
							const isToggling = toggling === name;
							const type = mcpTypes[name];

							return (
								<div
									key={name}
									className="flex items-center gap-3 rounded-lg border p-3 bg-card"
								>
									<div className="shrink-0 text-muted-foreground">
										{type === "remote" ? (
											<Globe className="size-4" />
										) : (
											<Terminal className="size-4" />
										)}
									</div>

									<div className="flex-1 min-w-0">
										<div className="flex items-center gap-2">
											<span className="text-sm font-medium font-mono truncate">
												{name}
											</span>
											<StatusBadge status={status} />
										</div>
										{status.status === "failed" && "error" in status && (
											<p className="text-[11px] text-destructive truncate mt-0.5">
												{status.error}
											</p>
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
			</DialogContent>
		</Dialog>
	);
}
