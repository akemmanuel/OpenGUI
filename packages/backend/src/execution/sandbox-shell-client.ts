import { request } from "node:http";
import type { ShellToolExecutor } from "@opengui/harness";

const MAX_RESPONSE_BYTES = 1024 * 1024;

function post(endpoint: string, token: string | undefined, body: string, signal: AbortSignal) {
  return new Promise<unknown>((resolve, reject) => {
    const remote = endpoint.startsWith("/") ? null : new URL(endpoint);
    const req = request(
      {
        ...(remote
          ? { hostname: remote.hostname, port: remote.port, path: remote.pathname }
          : { socketPath: endpoint, path: "/v1/execute" }),
        method: "POST",
        headers: {
          "content-type": "application/json",
          "content-length": Buffer.byteLength(body),
          ...(token ? { authorization: `Bearer ${token}` } : {}),
        },
        signal,
      },
      (response) => {
        const chunks: Buffer[] = [];
        let bytes = 0;
        response.on("data", (chunk: Buffer) => {
          bytes += chunk.length;
          if (bytes > MAX_RESPONSE_BYTES) req.destroy(new Error("Sandbox response is too large"));
          else chunks.push(chunk);
        });
        response.on("end", () => {
          try {
            const value = JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
            if ((response.statusCode ?? 500) >= 400) {
              reject(new Error("Sandbox shell broker rejected execution"));
            } else resolve(value);
          } catch (error) {
            reject(error);
          }
        });
      },
    );
    req.on("error", reject);
    req.end(body);
  });
}

export function createSandboxShellExecutor(endpoint: string, token?: string): ShellToolExecutor {
  return async (context, input) => {
    return await post(
      endpoint,
      token,
      JSON.stringify({
        projectDirectory: context.projectDirectory,
        grants: context.executionPolicy.grants ?? [],
        input,
        sessionId: context.sessionId,
        toolCallId: context.toolCallId,
      }),
      context.signal,
    );
  };
}
