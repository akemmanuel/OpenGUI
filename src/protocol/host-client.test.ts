import { describe, expect, test } from "vite-plus/test";
import { createHostClient } from "./host-client";

function eventStream(payloads: unknown[]) {
  const encoder = new TextEncoder();
  return new Response(
    new ReadableStream({
      start(controller) {
        for (const payload of payloads) {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(payload)}\n\n`));
        }
        controller.close();
      },
    }),
    { status: 200 },
  );
}

describe("Host event subscription", () => {
  test("reconnects a completed stream and requests authoritative backfill", async () => {
    let requests = 0;
    const client = createHostClient({
      baseUrl: "http://host.test",
      reconnectDelayMs: 0,
      fetchImpl: async () => {
        requests += 1;
        return eventStream([
          { type: "ready" },
          {
            sessionId: "session-1",
            event: { type: "assistant_delta", runId: `run-${requests}`, delta: "x" },
          },
        ]);
      },
    });
    const runIds: string[] = [];
    let readyCount = 0;
    let unsubscribe = () => {};

    await new Promise<void>((resolve) => {
      unsubscribe = client.subscribe(
        (event) => {
          if (event.event.type === "assistant_delta") runIds.push(event.event.runId);
          if (runIds.length === 2) resolve();
        },
        "session-1",
        () => {
          readyCount += 1;
        },
      );
    });
    unsubscribe();

    expect(runIds).toEqual(["run-1", "run-2"]);
    expect(readyCount).toBe(2);
    expect(requests).toBe(2);
  });
});

describe("Host follow-up client", () => {
  test("exposes queue management through the Host API", async () => {
    const requests: Array<{ url: string; method: string; body: string | null }> = [];
    const client = createHostClient({
      baseUrl: "http://host.test",
      fetchImpl: async (input, init) => {
        requests.push({
          url: input,
          method: init?.method ?? "GET",
          body: typeof init?.body === "string" ? init.body : null,
        });
        return Response.json({ ok: true, value: [] });
      },
    });

    await client.updateFollowUp("session/1", "follow/1", "Edited");
    await client.reorderFollowUp("session/1", "follow/1", 2);
    await client.removeFollowUp("session/1", "follow/1");
    await client.sendFollowUpNow("session/1", "follow/1");

    expect(requests).toEqual([
      {
        url: "http://host.test/api/host/sessions/session%2F1/follow-ups/follow%2F1",
        method: "PATCH",
        body: JSON.stringify({ text: "Edited" }),
      },
      {
        url: "http://host.test/api/host/sessions/session%2F1/follow-ups/follow%2F1/reorder",
        method: "POST",
        body: JSON.stringify({ index: 2 }),
      },
      {
        url: "http://host.test/api/host/sessions/session%2F1/follow-ups/follow%2F1",
        method: "DELETE",
        body: null,
      },
      {
        url: "http://host.test/api/host/sessions/session%2F1/follow-ups/follow%2F1/send-now",
        method: "POST",
        body: "{}",
      },
    ]);
  });
});
