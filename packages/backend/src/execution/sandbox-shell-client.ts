import { request } from "node:http";
import type { ShellToolExecutor } from "@opengui/harness";

const MAX_RESPONSE_BYTES = 1024 * 1024;

function post(socketPath: string, body: string, signal: AbortSignal) {
  return new Promise<unknown>((resolve, reject) => {
    const req = request(
      {
        socketPath,
        path: "/v1/execute",
        method: "POST",
        headers: { "content-type": "application/json", "content-length": Buffer.byteLength(body) },
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

export function createSandboxShellExecutor(socketPath: string): ShellToolExecutor {
  return async (context, input) => {
    return await post(
      socketPath,
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
