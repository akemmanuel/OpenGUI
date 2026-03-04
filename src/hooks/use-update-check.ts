import { useCallback, useEffect, useState } from "react";
import { STORAGE_KEYS } from "@/lib/constants";
import { storageGet, storageSet } from "@/lib/safe-storage";
import { compareSemver } from "@/lib/utils";
import packageJson from "../../package.json";

const GITHUB_RELEASES_URL =
	"https://api.github.com/repos/akemmanuel/OpenGUI/releases/latest";

/** Timeout for the GitHub API fetch (ms). */
const FETCH_TIMEOUT_MS = 5000;

export interface UpdateCheckResult {
	/** Whether a newer version is available (and not dismissed). */
	updateAvailable: boolean;
	/** The latest version string (without leading "v"). */
	latestVersion: string | null;
	/** URL to the GitHub release page. */
	releaseUrl: string | null;
	/** Dismiss this version so the popup won't show again until a newer one. */
	dismiss: () => void;
}

/**
 * On mount, checks the GitHub Releases API for a newer version of OpenGUI.
 * If a newer version exists and the user hasn't dismissed it, exposes the
 * update info so a dialog can be shown.
 */
export function useUpdateCheck(): UpdateCheckResult {
	const [latestVersion, setLatestVersion] = useState<string | null>(null);
	const [releaseUrl, setReleaseUrl] = useState<string | null>(null);
	const [dismissed, setDismissed] = useState(false);

	useEffect(() => {
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

		(async () => {
			try {
				const res = await fetch(GITHUB_RELEASES_URL, {
					signal: controller.signal,
				});
				if (!res.ok) return;

				const data = (await res.json()) as {
					tag_name?: string;
					html_url?: string;
				};
				const tag = data.tag_name;
				if (!tag) return;

				const version = tag.replace(/^v/, "");
				const url = data.html_url ?? null;

				// Only surface if the remote version is strictly newer
				if (compareSemver(version, packageJson.version) <= 0) return;

				// Check if the user already dismissed this exact version
				const dismissedVersion = storageGet(
					STORAGE_KEYS.DISMISSED_UPDATE_VERSION,
				);
				if (dismissedVersion === version) {
					setDismissed(true);
				}

				setLatestVersion(version);
				setReleaseUrl(url);
			} catch {
				// Network error, timeout, or aborted -- silently ignore.
			} finally {
				clearTimeout(timer);
			}
		})();

		return () => {
			controller.abort();
			clearTimeout(timer);
		};
	}, []);

	const dismiss = useCallback(() => {
		if (latestVersion) {
			storageSet(STORAGE_KEYS.DISMISSED_UPDATE_VERSION, latestVersion);
		}
		setDismissed(true);
	}, [latestVersion]);

	const updateAvailable = latestVersion !== null && !dismissed;

	return { updateAvailable, latestVersion, releaseUrl, dismiss };
}
