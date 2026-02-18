/**
 * Server connection settings.
 * A small status indicator in the sidebar footer that opens a modal
 * for configuring the server URL, auth, and adding a new project.
 */

import {
	AlertCircle,
	Bell,
	CheckCircle2,
	Mic,
	Play,
	PlugZap,
	Settings,
	Unplug,
} from "lucide-react";
import { type FormEvent, useCallback, useEffect, useState } from "react";
import { SettingsProviders } from "@/components/SettingsProviders";
import { Button } from "@/components/ui/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogHeader,
	DialogTitle,
	DialogTrigger,
} from "@/components/ui/dialog";
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
import { hasAnyConnection, useOpenCode } from "@/hooks/use-opencode";
import packageJson from "../../package.json";

const LOCAL_SERVER_URL = "http://127.0.0.1:4096";

// ---------------------------------------------------------------------------
// Compact footer badge (always visible in sidebar)
// ---------------------------------------------------------------------------

export function ConnectionPanel() {
	const [open, setOpen] = useState(false);

	return (
		<SidebarMenu className="group-data-[collapsible=icon]:p-0">
			<SidebarMenuItem>
				<Dialog open={open} onOpenChange={setOpen}>
					<DialogTrigger asChild>
						<SidebarMenuButton tooltip="Settings">
							<Settings />
							<span>Settings</span>
						</SidebarMenuButton>
					</DialogTrigger>
					<DialogContent className="sm:max-w-lg">
						<DialogHeader>
							<DialogTitle>Settings</DialogTitle>
							<DialogDescription>
								Manage server connections, providers, and preferences.
							</DialogDescription>
						</DialogHeader>
						<Tabs defaultValue="general">
							<TabsList className="w-full">
								<TabsTrigger value="general" className="flex-1">
									General
								</TabsTrigger>
								<TabsTrigger value="connection" className="flex-1">
									Connection
								</TabsTrigger>
								<TabsTrigger value="providers" className="flex-1">
									Providers
								</TabsTrigger>
							</TabsList>
							<TabsContent value="general">
								<GeneralSettings />
							</TabsContent>
							<TabsContent value="connection">
								<AddProjectForm onDone={() => setOpen(false)} />
							</TabsContent>
							<TabsContent value="providers">
								<SettingsProviders />
							</TabsContent>
						</Tabs>
					</DialogContent>
				</Dialog>
			</SidebarMenuItem>
		</SidebarMenu>
	);
}

// ---------------------------------------------------------------------------
// Add project form (inside the modal)
// ---------------------------------------------------------------------------

type ServerState = "checking" | "running" | "stopped" | "starting" | "error";

function AddProjectForm({ onDone }: { onDone: () => void }) {
	const { state, addProject, connectToProject, disconnect, clearError } =
		useOpenCode();
	const { connections } = state;
	const isConnected = hasAnyConnection(connections);
	const isElectron = !!window.electronAPI;

	const [url, setUrl] = useState(
		() => localStorage.getItem("opencode:serverUrl") ?? LOCAL_SERVER_URL,
	);
	const [username, setUsername] = useState(
		() => localStorage.getItem("opencode:username") ?? "",
	);
	const [directory, setDirectory] = useState("");
	const [password, setPassword] = useState("");
	const [showAuth, setShowAuth] = useState(false);
	const [isSubmitting, setIsSubmitting] = useState(false);

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
		checkServerStatus();
	}, [checkServerStatus]);

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

				const normalizedLocal = LOCAL_SERVER_URL.replace(/\/+$/, "");
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
						connectToProject(dir, LOCAL_SERVER_URL),
					);

					if (
						isTypedDirectoryLocal &&
						!directoriesToReconnect.includes(typedDirectory)
					) {
						reconnectTasks.push(
							addProject({
								baseUrl: url,
								username: username || undefined,
								password: password || undefined,
								directory: typedDirectory,
							}),
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
			setServerError(
				err instanceof Error ? err.message : "Failed to start server",
			);
		}
	};

	const handleSubmit = async (e: FormEvent) => {
		e.preventDefault();
		setIsSubmitting(true);
		clearError();
		await addProject({
			baseUrl: url,
			username: username || undefined,
			password: password || undefined,
			directory: directory.trim() || undefined,
		});
		setIsSubmitting(false);
		// Only close the dialog if the project was actually added (connection
		// exists for the directory). On failure, keep the dialog open so the
		// user can see the error and retry.
		const dir = directory.trim();
		if (dir && state.connections[dir]?.state === "connected") {
			onDone();
		}
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
							<div className="flex items-center gap-1.5 text-xs text-emerald-500">
								<CheckCircle2 className="size-3.5" />
								<span>Server running on port 4096</span>
							</div>
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
					disabled={isSubmitting}
					className="font-mono text-sm"
				/>
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
					OpenCode sessions are scoped by directory. Keep this path stable to
					reuse the same chats.
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
								className="text-sm"
							/>
						</div>
					</div>
				)}
			</div>

			{/* Actions */}
			<div className="flex justify-between gap-2">
				{isConnected && (
					<Button
						type="button"
						variant="ghost"
						size="sm"
						className="text-destructive"
						onClick={() => {
							disconnect();
							onDone();
						}}
					>
						<Unplug className="size-4 mr-1.5" />
						Disconnect all
					</Button>
				)}
				<div className="ml-auto">
					{isSubmitting ? (
						<Button type="button" size="sm" variant="secondary" disabled>
							<Spinner className="size-4 mr-1.5" />
							Connecting
						</Button>
					) : (
						<Button
							type="submit"
							size="sm"
							disabled={!url.trim() || !directory.trim()}
						>
							<PlugZap className="size-4 mr-1.5" />
							Add project
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
			<SttEndpointSetting />
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
// STT endpoint setting
// ---------------------------------------------------------------------------

function SttEndpointSetting() {
	const [endpoint, setEndpoint] = useState(() => {
		try {
			return localStorage.getItem("opencode:sttEndpoint") ?? "";
		} catch {
			return "";
		}
	});

	const handleChange = (value: string) => {
		setEndpoint(value);
		try {
			if (value.trim()) {
				localStorage.setItem("opencode:sttEndpoint", value.trim());
			} else {
				localStorage.removeItem("opencode:sttEndpoint");
			}
		} catch {
			/* ignore */
		}
		// Notify other components in the same tab
		window.dispatchEvent(new Event("stt-endpoint-changed"));
	};

	return (
		<div className="space-y-2">
			<div className="flex items-center gap-2">
				<Mic className="size-4 text-muted-foreground" />
				<Label htmlFor="stt-endpoint" className="text-sm font-normal">
					Voice transcription endpoint
				</Label>
			</div>
			<Input
				id="stt-endpoint"
				type="url"
				value={endpoint}
				onChange={(e) => handleChange(e.target.value)}
				placeholder="https://your-whisper-server.com/transcribe"
				className="font-mono text-sm"
			/>
			<p className="text-[11px] text-muted-foreground">
				URL of a Whisper-compatible STT server. The mic button will only appear
				when this is set.
			</p>
		</div>
	);
}

// ---------------------------------------------------------------------------
// Notifications toggle
// ---------------------------------------------------------------------------

function NotificationsToggle() {
	const [enabled, setEnabled] = useState(() => {
		try {
			const raw = localStorage.getItem("opencode:notificationsEnabled");
			return raw === null || raw === "true";
		} catch {
			return true;
		}
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
		try {
			localStorage.setItem("opencode:notificationsEnabled", String(checked));
		} catch {
			/* ignore */
		}
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
