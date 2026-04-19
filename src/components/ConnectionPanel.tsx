/**
 * Server connection settings.
 * Sidebar entry opens settings view in main content area.
 */

import {
	AlertCircle,
	ArrowLeft,
	Bell,
	CheckCircle2,
	Folder,
	Layers,
	Play,
	PlugZap,
	Settings,
	Square,
	Terminal,
	Unplug,
} from "lucide-react";
import { type FormEvent, useCallback, useEffect, useState } from "react";
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
	NOTIFICATIONS_ENABLED_KEY,
	useActions,
	useConnectionState,
} from "@/hooks/use-opencode";
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
					</TabsList>
					<TabsContent value="general" className="mt-0 rounded-lg border p-4">
						<GeneralSettings />
					</TabsContent>
					<TabsContent value="providers" className="mt-0 rounded-lg border p-4">
						<SettingsProviders />
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
			const res = await window.electronAPI?.opencode.getServerStatus();
			setServerState(res?.success && res.data?.running ? "running" : "stopped");
		} catch {
			setServerState("stopped");
		}
	}, [isElectron]);

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
			const res = await window.electronAPI?.opencode.startServer();
			if (!res) {
				setServerState("error");
				setServerError("Electron API unavailable");
				return;
			}
			if (res.success) {
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
			} else {
				setServerState("error");
				setServerError(res.error ?? "Failed to start server");
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
			const res = await window.electronAPI?.opencode.stopServer();
			if (!res) {
				setServerState("error");
				setServerError("Electron API unavailable");
				return;
			}
			if (res.success) {
				setServerState("stopped");
			} else {
				setServerState("error");
				setServerError(res.error ?? "Failed to stop server");
			}
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
		storageSet(STORAGE_KEYS.SERVER_URL, trimmedUrl);
		if (trimmedUsername) {
			storageSet(STORAGE_KEYS.USERNAME, trimmedUsername);
		} else {
			storageRemove(STORAGE_KEYS.USERNAME);
		}
		await connectToProject(
			directory.trim(),
			trimmedUrl,
			trimmedUsername || undefined,
			password || undefined,
		);
		setIsSubmitting(false);
		onDone();
	};

	return (
		<form onSubmit={handleSubmit} className="flex flex-col gap-4">
			{/* Local server status (Electron only) */}
			{isElectron && (
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
									title="Stop local opencode server"
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
									title="Start local opencode server"
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
					This window can open multiple projects, but they all share the same
					server connection. Use stable paths to reuse the same chats.
				</p>
			</div>

			{/* Auth */}
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
						<div className="flex-1 space-y-1">
							<Label htmlFor="auth-user" className="text-xs">
								Username
							</Label>
							<Input
								id="auth-user"
								type="text"
								value={username}
								onChange={(e) => setUsername(e.target.value)}
								placeholder="opencode"
								disabled={hasConnectedProjects}
								className="text-sm"
							/>
						</div>
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
					</div>
				)}
			</div>

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
							disabled={!url.trim() || !directory.trim()}
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
	return (
		<div className="flex flex-col gap-4">
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
