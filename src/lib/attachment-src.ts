export function resolveAttachmentImageSrc(
	url: string,
	serverUrl?: string | null,
): string {
	const trimmed = url.trim();
	if (!trimmed) return trimmed;
	if (/^(data:|blob:|https?:|file:)/i.test(trimmed)) return trimmed;

	const normalizedServerUrl =
		typeof serverUrl === "string" && serverUrl.trim()
			? serverUrl.trim().replace(/\/+$/, "")
			: null;
	if (normalizedServerUrl) {
		try {
			return new URL(trimmed, `${normalizedServerUrl}/`).toString();
		} catch {
			// Fall through to local-path handling.
		}
	}

	if (/^[a-zA-Z]:[\\/]/.test(trimmed)) {
		return `file:///${trimmed.replace(/\\/g, "/")}`;
	}
	if (trimmed.startsWith("/")) return `file://${trimmed}`;
	return trimmed;
}
