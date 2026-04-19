import { useCallback, useEffect, useState } from "react";
import { STORAGE_KEYS } from "@/lib/constants";
import { storageGet, storageSet } from "@/lib/safe-storage";
import { compareSemver } from "@/lib/utils";
import type { AppUpdateState } from "@/types/electron";
import packageJson from "../../package.json";

const GITHUB_RELEASES_URL =
	"https://api.github.com/repos/akemmanuel/OpenGUI/releases/latest";
const FETCH_TIMEOUT_MS = 5000;

const INITIAL_STATE: AppUpdateState = {
	status: "idle",
	platformSupported: false,
	currentVersion: packageJson.version,
	latestVersion: null,
	releaseDate: null,
	releaseNotes: null,
	releaseName: null,
	releaseUrl: null,
	progressPercent: null,
	bytesPerSecond: null,
	transferred: null,
	total: null,
	errorMessage: null,
	downloaded: false,
	autoDownload: true,
	updateInfoFetched: false,
};

export interface UpdateCheckResult {
	updateAvailable: boolean;
	latestVersion: string | null;
	releaseUrl: string | null;
	releaseNotes: string | null;
	status: AppUpdateState["status"];
	progressPercent: number | null;
	errorMessage: string | null;
	isSupported: boolean;
	isElectronManaged: boolean;
	canDismiss: boolean;
	dismiss: () => void;
	checkNow: () => Promise<void>;
	download: () => Promise<void>;
	install: () => Promise<void>;
}

function dismissVersion(version: string | null) {
	if (!version) return;
	storageSet(STORAGE_KEYS.DISMISSED_UPDATE_VERSION, version);
}

export function useUpdateCheck(): UpdateCheckResult {
	const bridge = window.electronAPI?.updates;
	const [state, setState] = useState<AppUpdateState>(INITIAL_STATE);
	const [dismissedVersion, setDismissedVersion] = useState<string | null>(
		() => storageGet(STORAGE_KEYS.DISMISSED_UPDATE_VERSION),
	);
	const [isElectronManaged, setIsElectronManaged] = useState(Boolean(bridge));

	useEffect(() => {
		if (!bridge) {
			setIsElectronManaged(false);
			const controller = new AbortController();
			const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
			setState((prev) => ({ ...prev, status: "checking" }));

			void (async () => {
				try {
					const res = await fetch(GITHUB_RELEASES_URL, {
						signal: controller.signal,
					});
					if (!res.ok) {
						setState((prev) => ({
							...prev,
							status: "error",
							errorMessage: `Update check failed: ${res.status}`,
						}));
						return;
					}

					const data = (await res.json()) as {
						tag_name?: string;
						html_url?: string;
						body?: string;
					};
					const tag = data.tag_name;
					if (!tag) {
						setState((prev) => ({ ...prev, status: "not-available" }));
						return;
					}

					const version = tag.replace(/^v/, "");
					if (compareSemver(version, packageJson.version) <= 0) {
						setState((prev) => ({ ...prev, status: "not-available" }));
						return;
					}

					setDismissedVersion(storageGet(STORAGE_KEYS.DISMISSED_UPDATE_VERSION));
					setState((prev) => ({
						...prev,
						status: "available",
						platformSupported: true,
						latestVersion: version,
						releaseUrl: data.html_url ?? null,
						releaseNotes: data.body ?? null,
						errorMessage: null,
						updateInfoFetched: true,
					}));
				} catch (error) {
					if (controller.signal.aborted) return;
					setState((prev) => ({
						...prev,
						status: "error",
						errorMessage:
							error instanceof Error ? error.message : "Update check failed",
					}));
				} finally {
					clearTimeout(timer);
				}
			})();

			return () => {
				controller.abort();
				clearTimeout(timer);
			};
		}

		setIsElectronManaged(true);
		void bridge.getState().then((nextState) => setState(nextState));
		const unsubscribe = bridge.onStateChanged((nextState) => {
			setState(nextState);
		});
		return unsubscribe;
	}, [bridge]);

	const dismiss = useCallback(() => {
		if (!state.latestVersion) return;
		dismissVersion(state.latestVersion);
		setDismissedVersion(state.latestVersion);
	}, [state.latestVersion]);

	const checkNow = useCallback(async () => {
		if (!bridge) return;
		setDismissedVersion(storageGet(STORAGE_KEYS.DISMISSED_UPDATE_VERSION));
		const nextState = await bridge.check();
		setState(nextState);
	}, [bridge]);

	const download = useCallback(async () => {
		if (!bridge) return;
		const nextState = await bridge.download();
		setState(nextState);
	}, [bridge]);

	const install = useCallback(async () => {
		if (!bridge) return;
		await bridge.install();
	}, [bridge]);

	const dismissed = state.latestVersion
		? dismissedVersion === state.latestVersion
		: false;
	const updateAvailable =
		(state.status === "available" ||
			state.status === "downloading" ||
			state.status === "downloaded") &&
		!dismissed;

	return {
		updateAvailable,
		latestVersion: state.latestVersion,
		releaseUrl: state.releaseUrl,
		releaseNotes: state.releaseNotes,
		status: state.status,
		progressPercent: state.progressPercent,
		errorMessage: state.errorMessage,
		isSupported: state.platformSupported,
		isElectronManaged,
		canDismiss: state.status !== "downloaded" && state.status !== "installing",
		dismiss,
		checkNow,
		download,
		install,
	};
}
