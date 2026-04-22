/**
 * Server connection settings.
 * Sidebar entry opens settings view in main content area.
 */

import {
	AlertCircle,
	ArrowLeft,
	Bell,
	BookOpen,
	CheckCircle2,
	Folder,
	Globe,
	Layers,
	Play,
	PlugZap,
	RotateCcw,
	Settings,
	Square,
	Terminal,
	Unplug,
} from "lucide-react";
import type { McpStatus } from "@opencode-ai/sdk/v2/client";
import { type FormEvent, useCallback, useEffect, useState } from "react";
import { Badge } from "@/components/ui/badge";
import {
	AlertDialog,
	AlertDialogAction,
	AlertDialogCancel,
	AlertDialogContent,
	AlertDialogDescription,
	AlertDialogFooter,
	AlertDialogHeader,
	AlertDialogTitle,
	AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { SettingsProviders } from "@/components/SettingsProviders";
import { ThemeToggle } from "@/components/ThemeToggle";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
	SidebarMenu,
	SidebarMenuButton,
	SidebarMenuItem,
} from "@/components/ui/sidebar";
import { Spinner } from "@/components/ui/spinner";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/ui/select";
import {
	NOTIFICATIONS_ENABLED_KEY,
	useActions,
	useConnectionState,
} from "@/hooks/use-agent-state";
import {
	setStoredAgentBackendId,
	useAgentBackend,
	useCurrentAgentBackendId,
} from "@/hooks/use-agent-backend";
import {
	DEFAULT_MODEL_MAX_AGE_MONTHS,
	DEFAULT_SERVER_URL,
	STORAGE_KEYS,
} from "@/lib/constants";
import { storageGet, storageRemove, storageSet } from "@/lib/safe-storage";
import { getErrorMessage } from "@/lib/utils";
import packageJson from "../../package.json";

// ---------------------------------------------------------------------------
// Compact footer badge (always visible in sidebar)
// ---------------------------------------------------------------------------

export function ConnectionPanel({
	onOpenSettings,
	isActive = false,
}: {
	onOpenSettings: () => void;
	isActive?: boolean;
}) {
	return (
		<SidebarMenu className="group-data-[collapsible=icon]:p-0">
			<SidebarMenuItem>
				<SidebarMenuButton
					tooltip="Settings"
					isActive={isActive}
					onClick={onOpenSettings}
				>
					<Settings />
					<span>Settings</span>
				</SidebarMenuButton>
			</SidebarMenuItem>
		</SidebarMenu>
	);
}

export function SettingsView({ onBack }: { onBack: () => void }) {
	return (
		<div className="h-full overflow-y-auto">
			<div className="mx-auto flex max-w-3xl flex-col gap-6 px-6 py-6">
				<div className="space-y-3">
					<Button
						type="button"
						variant="ghost"
						size="sm"
						className="w-fit"
						onClick={onBack}
					>
						<ArrowLeft className="size-4" />
						Back
					</Button>
					<div className="space-y-1">
						<h1 className="text-2xl font-semibold tracking-tight">Settings</h1>
						<p className="text-sm text-muted-foreground">
							Manage app preferences and providers for active workspace.
						</p>
					</div>
				</div>
				<Tabs defaultValue="general" className="gap-4">
					<TabsList className="w-full">
						<TabsTrigger value="general" className="flex-1">
							General
						</TabsTrigger>
						<TabsTrigger value="providers" className="flex-1">
							Providers
						</TabsTrigger>
						<TabsTrigger value="skills" className="flex-1">
							Skills
						</TabsTrigger>
						<TabsTrigger value="mcp" className="flex-1">
							Tools
						</TabsTrigger>
					</TabsList>
					<TabsContent value="general" className="mt-0 rounded-lg border p-4">
						<GeneralSettings />
					</TabsContent>
					<TabsContent value="providers" className="mt-0 rounded-lg border p-4">
						<SettingsProviders />
					</TabsContent>
					<TabsContent value="skills" className="mt-0 rounded-lg border p-4">
						<SkillsTabContent />
					</TabsContent>
					<TabsContent value="mcp" className="mt-0 rounded-lg border p-4">
						<McpTabContent />
					</TabsContent>
				</Tabs>
			</div>
		</div>
	);
}

// ---------------------------------------------------------------------------
// Workspace form (inside the modal)
// ---------------------------------------------------------------------------

type ServerState =
	| "checking"
	| "running"
	| "stopped"
	| "starting"
	| "stopping"
	| "error";

function _AddProjectForm({ onDone }: { onDone: () => void }) {
	const { connectToProject, clearError } = useActions();
	const { connections, workspaceServerUrl, workspaceUsername } =
		useConnectionState();
	const isElectron = !!window.electronAPI;

	const [url, setUrl] = useState(
		() => storageGet(STORAGE_KEYS.SERVER_URL) ?? DEFAULT_SERVER_URL,
	);
	const [username, setUsername] = useState(
		() => storageGet(STORAGE_KEYS.USERNAME) ?? "",
	);
	const [directory, setDirectory] = useState("");
	const [password, setPassword] = useState("");
	const [showAuth, setShowAuth] = useState(false);
	const [isSubmitting, setIsSubmitting] = useState(false);
	const backend = useAgentBackend();
	const workspaceProfile = backend?.workspace;
	const serverApi = backend?.platform?.server;
	const connectedProjectCount = Object.values(connections).filter(
		(conn) => conn.state === "connected",
	).length;
	const hasConnectedProjects = connectedProjectCount > 0;

	// Local server status (only relevant in Electron)
	const [serverState, setServerState] = useState<ServerState>("checking");
	const [serverError, setServerError] = useState<string | null>(null);

	const checkServerStatus = useCallback(async () => {
		if (!isElectron) return;
		setServerState("checking");
		try {
			const status = await serverApi?.status();
			setServerState(status?.running ? "running" : "stopped");
		} catch {
			setServerState("stopped");
		}
	}, [isElectron, serverApi]);

	// Check server status on mount
	useEffect(() => {
		void checkServerStatus();
	}, [checkServerStatus]);

	useEffect(() => {
		if (workspaceServerUrl) setUrl(workspaceServerUrl);
		setUsername(workspaceUsername ?? "");
	}, [workspaceServerUrl, workspaceUsername]);

	const handleStartServer = async () => {
		setServerState("starting");
		setServerError(null);
		try {
			if (!serverApi) {
				setServerState("error");
				setServerError("Electron API unavailable");
				return;
			}
			await serverApi.start();
			setServerState("running");
			clearError();

			const normalizedLocal = DEFAULT_SERVER_URL.replace(/\/+$/, "");
			const directoriesToReconnect = Object.entries(connections)
				.filter(
					([, conn]) =>
						conn.state !== "connected" &&
						(conn.serverUrl?.replace(/\/+$/, "") ?? "") === normalizedLocal,
				)
				.map(([dir]) => dir);

			const typedDirectory = directory.trim();
			const isTypedDirectoryLocal =
				url.replace(/\/+$/, "") === normalizedLocal &&
				typedDirectory.length > 0;

			setIsSubmitting(true);
			try {
				const reconnectTasks = directoriesToReconnect.map((dir) =>
					connectToProject(
						dir,
						DEFAULT_SERVER_URL,
						username || undefined,
						password || undefined,
					),
				);

				if (
					isTypedDirectoryLocal &&
					!directoriesToReconnect.includes(typedDirectory)
				) {
					reconnectTasks.push(
						connectToProject(
							typedDirectory,
							url,
							username || undefined,
							password || undefined,
						),
					);
				}

				if (reconnectTasks.length > 0) {
					await Promise.allSettled(reconnectTasks);
					onDone();
				}
			} finally {
				setIsSubmitting(false);
			}
		} catch (err) {
			setServerState("error");
			setServerError(getErrorMessage(err, "Failed to start server"));
		}
	};

	const handleStopServer = async () => {
		setServerState("stopping");
		setServerError(null);
		try {
			if (!serverApi) {
				setServerState("error");
				setServerError("Electron API unavailable");
				return;
			}
			await serverApi.stop();
			setServerState("stopped");
		} catch (err) {
			setServerState("error");
			setServerError(getErrorMessage(err, "Failed to stop server"));
		}
	};

	const handleSubmit = async (e: FormEvent) => {
		e.preventDefault();
		setIsSubmitting(true);
		clearError();
		const trimmedUrl = url.trim();
		const trimmedUsername = username.trim();
		if (workspaceProfile?.fields.serverUrl !== false) {
			storageSet(STORAGE_KEYS.SERVER_URL, trimmedUrl);
		}
		if (workspaceProfile?.fields.username && trimmedUsername) {
			storageSet(STORAGE_KEYS.USERNAME, trimmedUsername);
		} else {
			storageRemove(STORAGE_KEYS.USERNAME);
		}
		await connectToProject(
			directory.trim(),
			workspaceProfile?.fields.serverUrl !== false ? trimmedUrl : undefined,
			workspaceProfile?.fields.username ? (trimmedUsername || undefined) : undefined,
			workspaceProfile?.fields.password ? (password || undefined) : undefined,
		);
		setIsSubmitting(false);
		onDone();
	};

	return (
		<form onSubmit={handleSubmit} className="flex flex-col gap-4">
			{/* Local server status (Electron only) */}
			{isElectron && serverApi && (
				<div className="space-y-2">
					<Label>Local server</Label>
					<div className="flex items-center gap-2">
						{serverState === "checking" && (
							<div className="flex items-center gap-1.5 text-xs text-muted-foreground">
								<Spinner className="size-3.5" />
								<span>Checking server...</span>
							</div>
						)}
						{serverState === "running" && (
							<>
								<div className="flex items-center gap-1.5 text-xs text-emerald-500 flex-1">
									<CheckCircle2 className="size-3.5" />
									<span>Server running on port 4096</span>
								</div>
								<Button
									type="button"
									variant="outline"
									size="sm"
									onClick={handleStopServer}
									title="Stop local server"
								>
									<Square className="size-3 mr-1.5" />
									Stop server
								</Button>
							</>
						)}
						{serverState === "stopped" && (
							<>
								<div className="flex items-center gap-1.5 text-xs text-muted-foreground flex-1">
									<Unplug className="size-3.5" />
									<span>Server not running</span>
								</div>
								<Button
									type="button"
									variant="outline"
									size="sm"
									onClick={handleStartServer}
									disabled={isSubmitting}
									title="Start local server"
								>
									<Play className="size-3.5 mr-1.5" />
									Start server
								</Button>
							</>
						)}
						{serverState === "starting" && (
							<div className="flex items-center gap-1.5 text-xs text-muted-foreground">
								<Spinner className="size-3.5" />
								<span>Starting server...</span>
							</div>
						)}
						{serverState === "stopping" && (
							<div className="flex items-center gap-1.5 text-xs text-muted-foreground">
								<Spinner className="size-3.5" />
								<span>Stopping server...</span>
							</div>
						)}
						{serverState === "error" && (
							<>
								<div className="flex items-center gap-1.5 text-xs text-destructive flex-1 min-w-0">
									<AlertCircle className="size-3.5 shrink-0" />
									<span className="truncate">
										{serverError ?? "Failed to start"}
									</span>
								</div>
								<Button
									type="button"
									variant="outline"
									size="sm"
									onClick={handleStartServer}
								>
									Retry
								</Button>
							</>
						)}
					</div>
				</div>
			)}

			{/* URL */}
			{workspaceProfile?.fields.serverUrl !== false && (
				<div className="space-y-2">
					<Label htmlFor="server-url">Server URL</Label>
					<Input
						id="server-url"
						type="url"
						value={url}
						onChange={(e) => setUrl(e.target.value)}
						placeholder="http://127.0.0.1:4096"
						disabled={isSubmitting || hasConnectedProjects}
						className="font-mono text-sm"
					/>
					{hasConnectedProjects && (
						<p className="text-[11px] text-muted-foreground">
							This window is locked to one server while projects are open. Open a
							new window to use another server.
						</p>
					)}
				</div>
			)}

			{/* Directory */}
			<div className="space-y-2">
				<Label htmlFor="project-directory">Project directory</Label>
				<Input
					id="project-directory"
					type="text"
					value={directory}
					onChange={(e) => setDirectory(e.target.value)}
					placeholder="/absolute/path/to/project"
					disabled={isSubmitting}
					className="font-mono text-sm"
				/>
				<p className="text-[11px] text-muted-foreground">
					{workspaceProfile?.kind === "local-cli"
						? "Claude Code runs locally in this project directory. Use stable paths to reuse the same chats."
						: "This window can open multiple projects, but they all share the same server connection. Use stable paths to reuse the same chats."}
				</p>
			</div>

			{/* Auth */}
			{(workspaceProfile?.fields.username || workspaceProfile?.fields.password) && (
				<div className="space-y-2">
					<button
						type="button"
						onClick={() => setShowAuth(!showAuth)}
						className="text-xs text-muted-foreground hover:text-foreground transition-colors"
					>
						{showAuth ? "Hide authentication" : "Authentication (optional)"}
					</button>

					{showAuth && (
						<div className="flex gap-2">
							{workspaceProfile?.fields.username && (
								<div className="flex-1 space-y-1">
									<Label htmlFor="auth-user" className="text-xs">
										Username
									</Label>
									<Input
										id="auth-user"
										type="text"
										value={username}
										onChange={(e) => setUsername(e.target.value)}
										placeholder="username"
										disabled={hasConnectedProjects}
										className="text-sm"
									/>
								</div>
							)}
							{workspaceProfile?.fields.password && (
								<div className="flex-1 space-y-1">
									<Label htmlFor="auth-pass" className="text-xs">
										Password
									</Label>
									<Input
										id="auth-pass"
										type="password"
										value={password}
										onChange={(e) => setPassword(e.target.value)}
										placeholder="Password"
										disabled={hasConnectedProjects}
										className="text-sm"
									/>
								</div>
							)}
						</div>
					)}
				</div>
			)}

			{/* Actions */}
			<div className="flex justify-end gap-2">
				<div className="ml-auto">
					{isSubmitting ? (
						<Button type="button" size="sm" variant="secondary" disabled>
							<Spinner className="size-4 mr-1.5" />
							Opening
						</Button>
					) : (
						<Button
							type="submit"
							size="sm"
							disabled={
								(workspaceProfile?.fields.serverUrl !== false && !url.trim()) ||
								!directory.trim()
							}
						>
							<PlugZap className="size-4 mr-1.5" />
							Open project
						</Button>
					)}
				</div>
			</div>
		</form>
	);
}

// ---------------------------------------------------------------------------
// General settings (wraps all general tab items)
// ---------------------------------------------------------------------------

function GeneralSettings() {
	const backend = useAgentBackend();
	const backendId = useCurrentAgentBackendId();
	const serverApi = backend?.platform?.server;
	const [restarting, setRestarting] = useState(false);

	const handleRestart = useCallback(async () => {
		if (!serverApi) return;
		setRestarting(true);
		try {
			await serverApi.stop();
			await new Promise((r) => setTimeout(r, 1000));
			await serverApi.start();
			await new Promise((r) => setTimeout(r, 2000));
		} finally {
			setRestarting(false);
		}
	}, [serverApi]);

	return (
		<div className="flex flex-col gap-4">
			<div className="flex items-center justify-between gap-3">
				<div className="flex items-center gap-2">
					<Label className="text-sm font-normal">Agent backend</Label>
				</div>
				<Select
					value={backendId}
					onValueChange={(value) =>
						setStoredAgentBackendId(
							value === "claude-code" ? "claude-code" : "opencode",
						)
					}
				>
					<SelectTrigger className="w-[180px] h-8">
						<SelectValue placeholder="Select backend" />
					</SelectTrigger>
					<SelectContent>
						<SelectItem value="opencode">OpenCode</SelectItem>
						<SelectItem value="claude-code">Claude Code</SelectItem>
					</SelectContent>
				</Select>
			</div>
			<div className="flex items-center justify-between gap-3">
				<div className="flex items-center gap-2">
					<Label className="text-sm font-normal">Dark mode</Label>
				</div>
				<ThemeToggle />
			</div>
			<FileManagerSetting />
			<TerminalSetting />
			<ModelAgeFilterSetting />
			<NotificationsToggle />
			{serverApi && (
				<AlertDialog>
					<AlertDialogTrigger asChild>
						<Button
							variant="outline"
							size="sm"
							className="mt-2"
							disabled={restarting}
						>
							{restarting ? (
								<Spinner className="size-3.5 mr-2" />
							) : (
								<RotateCcw className="size-3.5 mr-2" />
							)}
							Restart Server
						</Button>
					</AlertDialogTrigger>
					<AlertDialogContent>
						<AlertDialogHeader>
							<AlertDialogTitle>Restart Server?</AlertDialogTitle>
							<AlertDialogDescription>
								This will restart the server. All open sessions will be stopped
								and you will need to reconnect.
							</AlertDialogDescription>
						</AlertDialogHeader>
						<AlertDialogFooter>
							<AlertDialogCancel>Cancel</AlertDialogCancel>
							<AlertDialogAction onClick={handleRestart}>
								Restart
							</AlertDialogAction>
						</AlertDialogFooter>
					</AlertDialogContent>
				</AlertDialog>
			)}
			<div className="flex items-center justify-between gap-3 pt-3 border-t">
				<span className="text-xs text-muted-foreground">Version</span>
				<span className="text-xs text-muted-foreground font-mono">
					{packageJson.version}
				</span>
			</div>
		</div>
	);
}

// ---------------------------------------------------------------------------
// Shared storage-input setting
// ---------------------------------------------------------------------------

import type { LucideIcon } from "lucide-react";

function StorageInputSetting({
	storageKey,
	id,
	icon: Icon,
	label,
	placeholder,
	helpText,
	inputType,
	onChangeExtra,
}: {
	storageKey: string;
	id: string;
	icon: LucideIcon;
	label: string;
	placeholder: string;
	helpText: string;
	inputType?: string;
	onChangeExtra?: () => void;
}) {
	const [value, setValue] = useState(() => storageGet(storageKey) ?? "");

	const handleChange = (newValue: string) => {
		setValue(newValue);
		if (newValue.trim()) {
			storageSet(storageKey, newValue.trim());
		} else {
			storageRemove(storageKey);
		}
		onChangeExtra?.();
	};

	return (
		<div className="space-y-2">
			<div className="flex items-center gap-2">
				<Icon className="size-4 text-muted-foreground" />
				<Label htmlFor={id} className="text-sm font-normal">
					{label}
				</Label>
			</div>
			<Input
				id={id}
				type={inputType}
				value={value}
				onChange={(e) => handleChange(e.target.value)}
				placeholder={placeholder}
				className="font-mono text-sm"
			/>
			<p className="text-[11px] text-muted-foreground">{helpText}</p>
		</div>
	);
}

// ---------------------------------------------------------------------------
// Model age filter setting
// ---------------------------------------------------------------------------

function ModelAgeFilterSetting() {
	const [enabled, setEnabled] = useState(() => {
		const raw = storageGet(STORAGE_KEYS.MODEL_MAX_AGE_MONTHS);
		if (raw === null) return true;
		const parsed = Number(raw);
		return !Number.isFinite(parsed) || parsed > 0;
	});
	const [months, setMonths] = useState(() => {
		const raw = storageGet(STORAGE_KEYS.MODEL_MAX_AGE_MONTHS);
		if (raw === null) return String(DEFAULT_MODEL_MAX_AGE_MONTHS);
		const parsed = Number(raw);
		if (!Number.isFinite(parsed) || parsed <= 0) {
			return String(DEFAULT_MODEL_MAX_AGE_MONTHS);
		}
		return String(Math.round(parsed));
	});

	const broadcastChange = () => {
		window.dispatchEvent(new Event("model-max-age-months-changed"));
	};

	const persistMonths = (value: string) => {
		const parsed = Number(value);
		if (Number.isFinite(parsed) && parsed > 0) {
			storageSet(STORAGE_KEYS.MODEL_MAX_AGE_MONTHS, String(Math.round(parsed)));
		} else {
			storageSet(
				STORAGE_KEYS.MODEL_MAX_AGE_MONTHS,
				String(DEFAULT_MODEL_MAX_AGE_MONTHS),
			);
		}
		broadcastChange();
	};

	const handleToggle = (checked: boolean) => {
		setEnabled(checked);
		if (!checked) {
			storageSet(STORAGE_KEYS.MODEL_MAX_AGE_MONTHS, "0");
			broadcastChange();
			return;
		}
		persistMonths(months);
	};

	const handleMonthsChange = (value: string) => {
		const digitsOnly = value.replace(/[^0-9]/g, "");
		setMonths(digitsOnly);
		if (!enabled) return;
		persistMonths(digitsOnly);
	};

	const handleMonthsBlur = () => {
		if (months) return;
		const fallback = String(DEFAULT_MODEL_MAX_AGE_MONTHS);
		setMonths(fallback);
		if (enabled) persistMonths(fallback);
	};

	return (
		<div className="space-y-2 pt-3 border-t">
			<div className="flex items-center justify-between gap-3">
				<div className="flex items-center gap-2">
					<Layers className="size-4 text-muted-foreground" />
					<Label
						htmlFor="model-age-filter-toggle"
						className="text-sm font-normal"
					>
						Hide old models
					</Label>
				</div>
				<Switch
					id="model-age-filter-toggle"
					size="sm"
					checked={enabled}
					onCheckedChange={handleToggle}
				/>
			</div>
			<div className="flex items-center gap-2">
				<Input
					id="model-age-filter-months"
					type="number"
					min="1"
					step="1"
					value={months}
					onChange={(e) => handleMonthsChange(e.target.value)}
					onBlur={handleMonthsBlur}
					disabled={!enabled}
					className="font-mono text-sm w-24"
				/>
				<Label
					htmlFor="model-age-filter-months"
					className="text-sm text-muted-foreground"
				>
					months
				</Label>
			</div>
			<p className="text-[11px] text-muted-foreground">
				Selected and favorite models always stay visible. Models without a valid
				release date also stay visible.
			</p>
		</div>
	);
}

// ---------------------------------------------------------------------------
// Notifications toggle
// ---------------------------------------------------------------------------

function NotificationsToggle() {
	const [enabled, setEnabled] = useState(() => {
		const raw = storageGet(NOTIFICATIONS_ENABLED_KEY);
		return raw === null || raw === "true";
	});

	const handleToggle = async (checked: boolean) => {
		if (
			checked &&
			typeof Notification !== "undefined" &&
			Notification.permission === "default"
		) {
			const result = await Notification.requestPermission();
			if (result === "denied") return;
		}
		setEnabled(checked);
		storageSet(NOTIFICATIONS_ENABLED_KEY, String(checked));
	};

	const permissionDenied =
		typeof Notification !== "undefined" && Notification.permission === "denied";

	return (
		<div className="flex items-center justify-between gap-3 pt-3 border-t">
			<div className="flex items-center gap-2">
				<Bell className="size-4 text-muted-foreground" />
				<Label htmlFor="notifications-toggle" className="text-sm font-normal">
					Desktop notifications
				</Label>
			</div>
			{permissionDenied ? (
				<span className="text-xs text-muted-foreground">
					Blocked by browser
				</span>
			) : (
				<Switch
					id="notifications-toggle"
					size="sm"
					checked={enabled}
					onCheckedChange={handleToggle}
				/>
			)}
		</div>
	);
}

// ---------------------------------------------------------------------------
// File manager setting
// ---------------------------------------------------------------------------

function FileManagerSetting() {
	return (
		<StorageInputSetting
			storageKey={STORAGE_KEYS.FILE_MANAGER}
			id="file-manager"
			icon={Folder}
			label="File manager"
			placeholder="Auto-detect"
			helpText="Command to open your file manager (e.g. nemo, nautilus). Leave empty to auto-detect."
		/>
	);
}

// ---------------------------------------------------------------------------
// Terminal setting
// ---------------------------------------------------------------------------

function TerminalSetting() {
	return (
		<StorageInputSetting
			storageKey={STORAGE_KEYS.TERMINAL}
			id="terminal"
			icon={Terminal}
			label="Terminal"
			placeholder="Auto-detect"
			helpText="Command to open your terminal (e.g. ghostty, kitty). Leave empty to auto-detect."
		/>
	);
}

// ---------------------------------------------------------------------------
// Skills tab content (inline)
// ---------------------------------------------------------------------------

interface SkillInfo {
	name: string;
	description: string;
	location: string;
	content: string;
}

function SkillsTabContent() {
	const backend = useAgentBackend();
	const skillsApi = backend?.platform?.skills;
	const { activeDirectory, activeWorkspaceId } = useConnectionState();
	const scopedDirectory = activeDirectory ?? undefined;

	const [skills, setSkills] = useState<SkillInfo[]>([]);
	const [loading, setLoading] = useState(true);

	const refresh = useCallback(async () => {
		if (!skillsApi) return;
		setSkills(
			await skillsApi.list({
				directory: scopedDirectory,
				workspaceId: activeWorkspaceId,
			}),
		);
		setLoading(false);
	}, [skillsApi, scopedDirectory, activeWorkspaceId]);

	useEffect(() => {
		void refresh();
	}, [refresh]);

	const getSourceType = (location: string): "local" | "url" => {
		if (location.startsWith("http://") || location.startsWith("https://")) {
			return "url";
		}
		return "local";
	};

	if (loading) {
		return (
			<div className="flex items-center justify-center py-8">
				<Spinner className="size-5" />
			</div>
		);
	}

	return (
		<div className="space-y-6">
			<div className="space-y-3">
				<h3 className="text-sm font-medium">Available Skills</h3>
				{skills.length === 0 ? (
					<div className="text-center py-4 text-sm text-muted-foreground">
						No skills discovered.
					</div>
				) : (
					<div className="space-y-2">
						{skills.map((skill) => {
							const source = getSourceType(skill.location);
							return (
								<div
									key={skill.name}
									className="flex items-start gap-3 rounded-lg border p-3 bg-card"
								>
									<BookOpen className="size-4 text-muted-foreground shrink-0 mt-0.5" />
									<div className="flex-1 min-w-0">
										<div className="flex items-center gap-2">
											<span className="text-sm font-medium">{skill.name}</span>
											<Badge
												variant="secondary"
												className="text-[10px] px-1.5 py-0"
											>
												{source === "url" ? "Remote" : "Local"}
											</Badge>
										</div>
										<p className="text-xs text-muted-foreground mt-0.5">
											{skill.description}
										</p>
										<p className="text-[10px] text-muted-foreground font-mono truncate mt-1">
											{skill.location}
										</p>
									</div>
								</div>
							);
						})}
					</div>
				)}
			</div>
		</div>
	);
}

// ---------------------------------------------------------------------------
// MCP/Tools tab content (inline)
// ---------------------------------------------------------------------------

function McpTabContent() {
	const backend = useAgentBackend();
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
				await mcpApi.disconnect({ directory: scopedDirectory, workspaceId: activeWorkspaceId }, name);
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

	const entries = Object.entries(mcpStatus).sort(([a], [b]) =>
		a.localeCompare(b),
	);

	if (loading) {
		return (
			<div className="flex items-center justify-center py-8">
				<Spinner className="size-5" />
			</div>
		);
	}

	return (
		<div className="space-y-2">
			{entries.length === 0 ? (
				<div className="text-center py-6 text-sm text-muted-foreground">
					No MCP servers configured.
				</div>
			) : (
				entries.map(([name, status]) => {
					const isConnected = status.status === "connected";
					const isToggling = toggling === name;
					const type = mcpTypes[name];
					const config = STATUS_CONFIG[
						status.status as keyof typeof STATUS_CONFIG
					] ?? { variant: "secondary" as const, label: "Unknown" };
					const BadgeIcon = "icon" in config ? config.icon : undefined;

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
									<Badge
										variant={config.variant}
										className={`text-xs${BadgeIcon ? " gap-1" : ""}${"className" in config ? ` ${config.className}` : ""}`}
									>
										{BadgeIcon && <BadgeIcon className="size-3" />}
										{config.label}
									</Badge>
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
	);
}
