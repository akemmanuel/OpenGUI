import type { Agent, Command, Provider } from "@opencode-ai/sdk/v2/client";
import { type MutableRefObject, useCallback, useEffect, useRef } from "react";
import type {
	ConnectionConfig,
	ConnectionStatus,
	OpenCodeBridge,
	ProvidersData,
	SelectedModel,
} from "@/types/electron";
import type { Session } from "../use-opencode";
import type { VariantSelections } from "./use-variant";

type DispatchAction =
	| {
			type: "SET_PROJECT_CONNECTION";
			payload: { directory: string; status: ConnectionStatus };
	  }
	| { type: "SET_ERROR"; payload: string | null }
	| {
			type: "MERGE_PROJECT_SESSIONS";
			payload: { directory: string; sessions: Session[] };
	  }
	| { type: "INIT_BUSY_SESSIONS"; payload: Record<string, { type: string }> }
	| { type: "SET_PROVIDERS"; payload: ProvidersData }
	| { type: "SET_SELECTED_MODEL"; payload: SelectedModel | null }
	| { type: "SET_VARIANT_SELECTIONS"; payload: VariantSelections }
	| { type: "SET_AGENTS"; payload: Agent[] }
	| { type: "SET_SELECTED_AGENT"; payload: string | null }
	| { type: "SET_COMMANDS"; payload: Command[] }
	| { type: "SET_RECENT_PROJECTS"; payload: RecentProject[] }
	| { type: "REMOVE_PROJECT"; payload: string }
	| { type: "SET_ACTIVE_SESSION"; payload: string | null }
	| {
			type: "SET_BOOT_STATE";
			payload: { state: BootState; error?: string | null };
	  }
	| { type: "CLEAR_ALL_PROJECTS" };

type BootState =
	| "idle"
	| "checking-server"
	| "starting-server"
	| "ready"
	| "error";

interface RecentProject {
	directory: string;
	serverUrl: string;
	username?: string;
	lastConnected: number;
}

interface UseConnectionsParams {
	bridge: OpenCodeBridge | undefined;
	sessions: Session[];
	activeSessionId: string | null;
	expectedDirectoriesRef: MutableRefObject<Set<string>>;
	dispatch: (action: DispatchAction) => void;
	isLocalServer: () => boolean;
	getOpenProjects: () => RecentProject[];
	clearOpenProjects: () => void;
	addRecentProject: (project: RecentProject) => RecentProject[];
	upsertOpenProject: (project: RecentProject) => RecentProject[];
	removeOpenProject: (directory: string) => RecentProject[];
}

export function resolveServerDefaultModel(
	providers: Provider[],
	providerDefaults: Record<string, string>,
): SelectedModel | null {
	for (const provider of providers) {
		const modelID = providerDefaults[provider.id];
		if (typeof modelID !== "string") continue;
		if (!(modelID in provider.models)) continue;
		return { providerID: provider.id, modelID };
	}

	for (const raw of Object.values(providerDefaults)) {
		if (typeof raw !== "string") continue;
		const splitIdx = raw.indexOf("/");
		if (splitIdx <= 0 || splitIdx >= raw.length - 1) continue;
		const providerID = raw.slice(0, splitIdx);
		const modelID = raw.slice(splitIdx + 1);
		const provider = providers.find((p) => p.id === providerID);
		if (!provider || !(modelID in provider.models)) continue;
		return { providerID, modelID };
	}

	return null;
}

export function useConnections({
	bridge,
	sessions,
	activeSessionId,
	expectedDirectoriesRef,
	dispatch,
	isLocalServer,
	getOpenProjects,
	clearOpenProjects,
	addRecentProject,
	upsertOpenProject,
	removeOpenProject,
}: UseConnectionsParams) {
	const globalDataLoaded = useRef(false);

	const addProject = useCallback(
		async (config: ConnectionConfig, options?: { suppressError?: boolean }) => {
			if (!bridge || !config.directory) return;
			expectedDirectoriesRef.current.add(config.directory);
			if (!options?.suppressError) {
				dispatch({ type: "SET_ERROR", payload: null });
			}

			const res = await bridge.addProject(config);
			if (!res.success) {
				expectedDirectoriesRef.current.delete(config.directory);
				if (!options?.suppressError) {
					dispatch({
						type: "SET_ERROR",
						payload: res.error ?? "Connection failed",
					});
				}
				return;
			}

			const sessRes = await bridge.listSessions(config.directory);
			if (sessRes.success && sessRes.data) {
				dispatch({
					type: "MERGE_PROJECT_SESSIONS",
					payload: {
						directory: config.directory,
						sessions: sessRes.data as Session[],
					},
				});
			}

			try {
				const statusRes = await bridge.getSessionStatuses(config.directory);
				if (statusRes.success && statusRes.data) {
					dispatch({ type: "INIT_BUSY_SESSIONS", payload: statusRes.data });
				}
			} catch {
				/* ignore */
			}

			if (!globalDataLoaded.current) {
				const [provRes, agentRes, cmdRes] = await Promise.all([
					bridge.getProviders(),
					bridge.getAgents(),
					bridge.getCommands(),
				]);
				globalDataLoaded.current = !!(provRes.success && provRes.data);
				if (provRes.success && provRes.data) {
					dispatch({ type: "SET_PROVIDERS", payload: provRes.data });
					let restoredSelection = false;
					try {
						const saved = localStorage.getItem("opencode:selectedModel");
						if (saved) {
							const parsed = JSON.parse(saved) as SelectedModel;
							const prov = provRes.data.providers.find(
								(p: Provider) => p.id === parsed.providerID,
							);
							if (prov && parsed.modelID in prov.models) {
								dispatch({ type: "SET_SELECTED_MODEL", payload: parsed });
								restoredSelection = true;
							}
						}
					} catch {
						/* ignore */
					}
					if (!restoredSelection) {
						const fallback = resolveServerDefaultModel(
							provRes.data.providers,
							provRes.data.default,
						);
						if (fallback) {
							dispatch({ type: "SET_SELECTED_MODEL", payload: fallback });
						}
					}
					try {
						const saved = localStorage.getItem("opencode:variantSelections");
						if (saved) {
							dispatch({
								type: "SET_VARIANT_SELECTIONS",
								payload: JSON.parse(saved) as VariantSelections,
							});
						}
					} catch {
						/* ignore */
					}
				}
				if (agentRes.success && agentRes.data) {
					dispatch({ type: "SET_AGENTS", payload: agentRes.data });
					try {
						const saved = localStorage.getItem("opencode:selectedAgent");
						if (saved) {
							const exists = agentRes.data.some((a: Agent) => a.name === saved);
							if (exists) {
								dispatch({ type: "SET_SELECTED_AGENT", payload: saved });
							}
						}
					} catch {
						/* ignore */
					}
				}
				if (cmdRes.success && cmdRes.data) {
					dispatch({ type: "SET_COMMANDS", payload: cmdRes.data });
				}
			}

			try {
				localStorage.setItem("opencode:serverUrl", config.baseUrl);
				localStorage.setItem("opencode:directory", config.directory);
				if (config.username) {
					localStorage.setItem("opencode:username", config.username);
				} else {
					localStorage.removeItem("opencode:username");
				}
			} catch {
				/* ignore */
			}

			const now = Date.now();
			const project: RecentProject = {
				directory: config.directory,
				serverUrl: config.baseUrl,
				username: config.username,
				lastConnected: now,
			};
			const updated = addRecentProject(project);
			upsertOpenProject(project);
			dispatch({ type: "SET_RECENT_PROJECTS", payload: updated });
		},
		[
			bridge,
			dispatch,
			expectedDirectoriesRef,
			addRecentProject,
			upsertOpenProject,
		],
	);

	const removeProject = useCallback(
		async (directory: string) => {
			if (!bridge) return;
			expectedDirectoriesRef.current.delete(directory);
			await bridge.removeProject(directory);
			removeOpenProject(directory);
			dispatch({ type: "REMOVE_PROJECT", payload: directory });
			const activeSession = sessions.find((s) => s.id === activeSessionId);
			if (
				(activeSession?._projectDir ?? activeSession?.directory) === directory
			) {
				dispatch({ type: "SET_ACTIVE_SESSION", payload: null });
			}
		},
		[
			bridge,
			dispatch,
			expectedDirectoriesRef,
			removeOpenProject,
			sessions,
			activeSessionId,
		],
	);

	const disconnect = useCallback(async () => {
		if (!bridge) return;
		await bridge.disconnect();
		expectedDirectoriesRef.current.clear();
		clearOpenProjects();
		globalDataLoaded.current = false;
		dispatch({ type: "CLEAR_ALL_PROJECTS" });
	}, [bridge, dispatch, expectedDirectoriesRef, clearOpenProjects]);

	const openDirectory = useCallback(async (): Promise<string | null> => {
		if (window.electronAPI?.openDirectory && isLocalServer()) {
			return window.electronAPI.openDirectory();
		}
		const dir = window.prompt("Enter the project directory path:");
		return dir?.trim() || null;
	}, [isLocalServer]);

	const connectToProject = useCallback(
		async (directory: string, serverUrl?: string) => {
			const url =
				serverUrl ??
				localStorage.getItem("opencode:serverUrl") ??
				"http://127.0.0.1:4096";
			const username = localStorage.getItem("opencode:username") ?? undefined;
			await addProject({
				baseUrl: url,
				directory,
				username: username || undefined,
			});
		},
		[addProject],
	);

	const refreshProviders = useCallback(async () => {
		if (!bridge) return;
		const res = await bridge.getProviders();
		if (res.success && res.data) {
			dispatch({ type: "SET_PROVIDERS", payload: res.data });
		}
	}, [bridge, dispatch]);

	const startupAttempted = useRef(false);
	useEffect(() => {
		if (!bridge || startupAttempted.current) return;
		startupAttempted.current = true;
		let cancelled = false;

		const bootstrap = async () => {
			const opencodeBridge = window.electronAPI?.opencode;
			if (!opencodeBridge) {
				dispatch({ type: "SET_BOOT_STATE", payload: { state: "ready" } });
				return;
			}

			if (isLocalServer()) {
				dispatch({
					type: "SET_BOOT_STATE",
					payload: { state: "checking-server" },
				});
				const statusRes = await opencodeBridge.getServerStatus();
				if (!statusRes.success) {
					if (cancelled) return;
					dispatch({
						type: "SET_BOOT_STATE",
						payload: {
							state: "error",
							error: statusRes.error ?? "Failed to check local server status",
						},
					});
					return;
				}

				if (!statusRes.data?.running) {
					dispatch({
						type: "SET_BOOT_STATE",
						payload: { state: "starting-server" },
					});
					const startRes = await opencodeBridge.startServer();
					if (!startRes.success) {
						if (cancelled) return;
						dispatch({
							type: "SET_BOOT_STATE",
							payload: {
								state: "error",
								error: startRes.error ?? "Failed to start local server",
							},
						});
						return;
					}
				}
			}

			if (cancelled) return;
			dispatch({ type: "SET_ERROR", payload: null });
			try {
				const projects = getOpenProjects();
				expectedDirectoriesRef.current = new Set(
					projects.map((project) => project.directory),
				);
				await Promise.allSettled(
					projects.map((project) =>
						addProject(
							{
								baseUrl: project.serverUrl,
								directory: project.directory,
								username: project.username,
							},
							{ suppressError: true },
						),
					),
				);
			} catch {
				/* ignore */
			}

			if (cancelled) return;
			dispatch({ type: "SET_BOOT_STATE", payload: { state: "ready" } });
		};

		bootstrap();
		return () => {
			cancelled = true;
		};
	}, [
		bridge,
		dispatch,
		expectedDirectoriesRef,
		isLocalServer,
		getOpenProjects,
		addProject,
	]);

	return {
		addProject,
		removeProject,
		disconnect,
		openDirectory,
		connectToProject,
		refreshProviders,
	};
}
