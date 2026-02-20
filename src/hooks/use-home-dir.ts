import { useEffect, useState } from "react";

/**
 * Returns the user's home directory via the Electron bridge.
 *
 * The value is fetched once on mount and cached for the lifetime of
 * the component. Returns an empty string while loading or when the
 * Electron API is unavailable.
 */
export function useHomeDir(): string {
	const [homeDir, setHomeDir] = useState("");

	useEffect(() => {
		window.electronAPI
			?.getHomeDir?.()
			.then((d) => setHomeDir(d ?? ""))
			.catch(() => {
				/* Electron API unavailable */
			});
	}, []);

	return homeDir;
}
