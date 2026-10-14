import { describe, expect, test } from "vite-plus/test";
import { retryProviderRequest } from "./provider-retry.ts";

const fast = { timeoutMs: 1_000, maxRetries: 2, maxRetryDelayMs: 1 };

describe("retryProviderRequest", () => {
  test("repeats retryable answers until one succeeds", async () => {
    const answers = [503, 429, 200];
    let calls = 0;
    const status = await retryProviderRequest(
      async () => answers[calls++]!,
      (value) => value !== 200,
      { delivery: fast, signal: new AbortController().signal },
    );
    expect(status).toBe(200);
    expect(calls).toBe(3);
  });

  test("returns the last answer once the retry budget is spent", async () => {
    let calls = 0;
    const status = await retryProviderRequest(
      async () => {
        calls += 1;
        return 503;
      },
      () => true,
      { delivery: fast, signal: new AbortController().signal },
    );
    expect(status).toBe(503);
    expect(calls).toBe(3);
  });

  test("never repeats a rejected attempt", async () => {
    let calls = 0;
    await expect(
      retryProviderRequest(
        async () => {
          calls += 1;
          throw new TypeError("fetch failed");
        },
        () => true,
        { delivery: fast, signal: new AbortController().signal },
      ),
    ).rejects.toThrow("fetch failed");
    expect(calls).toBe(1);
  });

  test("aborting during backoff rejects with an AbortError", async () => {
    const controller = new AbortController();
    const pending = retryProviderRequest(
      async () => 503,
      () => true,
      { delivery: { ...fast, maxRetryDelayMs: 60_000 }, signal: controller.signal },
    );
    setTimeout(() => controller.abort(), 20);
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
  });
});
