export interface SseClient {
  send: (payload: string, id?: string) => Promise<void>;
  close: () => Promise<void>;
}

function formatSseMessage(payload: string, id?: string) {
  const lines = payload.split(/\r?\n/).map((line) => `data: ${line}`);
  return `${id ? `id: ${id}\n` : ""}${lines.join("\n")}\n\n`;
}

export function createSseResponse(
  signal: AbortSignal,
  register: (client: SseClient) => void | Promise<void>,
  unregister: (client: SseClient) => void,
) {
  const stream = new TransformStream<Uint8Array, Uint8Array>();
  const writer = stream.writable.getWriter();
  const encoder = new TextEncoder();

  let pendingWrite = Promise.resolve();
  const client: SseClient = {
    send: async (payload: string, id?: string) => {
      pendingWrite = pendingWrite.then(() =>
        writer.write(encoder.encode(formatSseMessage(payload, id))),
      );
      await pendingWrite;
    },
    close: async () => {
      await pendingWrite.catch(() => undefined);
      await writer.close();
    },
  };

  const cleanup = () => {
    unregister(client);
    void client.close().catch(() => undefined);
  };

  signal.addEventListener("abort", cleanup, { once: true });
  void register(client);
  void client.send(JSON.stringify({ ok: true, connected: true })).catch(() => undefined);

  return new Response(stream.readable, {
    headers: {
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "content-type": "text/event-stream; charset=utf-8",
      "x-accel-buffering": "no",
    },
  });
}
