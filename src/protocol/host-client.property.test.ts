import { describe, expect, test } from "vite-plus/test";
import { bytePartitions, seeded } from "../lib/__tests__/seeded.ts";
import { createHostClient, redactHostError } from "./host-client.ts";

function stream(chunks: Uint8Array[]) {
  return new Response(
    new ReadableStream({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(chunk);
        controller.close();
      },
    }),
  );
}

describe("seeded Host URL, JSON, and SSE properties", () => {
  test("encodes arbitrary identifiers as exactly one URL path segment", async () => {
    const random = seeded(0x55524c31);
    for (let iteration = 0; iteration < 250; iteration += 1) {
      const id = Array.from({ length: random.int(1, 30) }, () =>
        random.pick(["a", "/", "?", "#", "%", " ", "🙂", "é", "&"]),
      ).join("");
      let requested = "";
      const client = createHostClient({
        baseUrl: "https://host.example///",
        fetchImpl: async (url) => {
          requested = url;
          return Response.json({ ok: true, value: {} });
        },
      });
      await client.readSession(id);
      expect(requested).toBe(`https://host.example/api/host/sessions/${encodeURIComponent(id)}`);
    }
  });

  test("parses Unicode SSE events across 80 byte-level chunkings and ignores malformed JSON", async () => {
    for (let seed = 1; seed <= 80; seed += 1) {
      const payload = JSON.stringify({
        sessionId: `session-${seed}`,
        event: { type: "assistant_delta", runId: "run", delta: "🙂 café 漢字" },
      });
      const wire = `data: {bad}\r\n\r\ndata: {"type":"ready"}\r\n\r\ndata: ${payload}\r\n\r\n`;
      let ready = 0;
      const client = createHostClient({
        reconnectDelayMs: 60_000,
        fetchImpl: async () => stream(bytePartitions(wire, seed)),
      });
      let stop = () => {};
      const received = await new Promise<any>((resolve) => {
        stop = client.subscribe(resolve, undefined, () => (ready += 1));
      });
      stop();
      expect(received.event.delta, `seed ${seed}`).toBe("🙂 café 漢字");
      expect(ready).toBe(1);
    }
  });

  test("redaction never retains generated bearer, JSON, or query secrets", () => {
    const random = seeded(0x52454441);
    for (let iteration = 0; iteration < 500; iteration += 1) {
      const secret = `s3cr3t-${iteration}-${random.next().toString(36)}`;
      const redacted = redactHostError(
        `Bearer ${secret} {"access_token":"${secret}"} https://x.test/?api_key=${secret}&ok=1`,
      );
      expect(redacted).not.toContain(secret);
      expect(redacted.match(/\[REDACTED\]/gu)).toHaveLength(3);
    }
  });
});
