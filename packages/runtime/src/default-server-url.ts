/** Default local OpenCode HTTP server (matches opencode-bridge LOCAL_SERVER_URL). */
const port = Number.parseInt(process.env.OPENGUI_OPENCODE_PORT ?? "4096", 10);
export const DEFAULT_OPENCODE_BASE_URL = `http://127.0.0.1:${port}`;
