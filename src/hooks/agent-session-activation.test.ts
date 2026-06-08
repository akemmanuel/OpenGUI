import { describe, expect, test } from "@voidzero-dev/vite-plus-test";
import {
  createBufferedSessionMessages,
  createRefreshMessageLimit,
  deriveSelectionFromMessages,
} from "./agent-session-activation";

describe("deriveSelectionFromMessages", () => {
  test("ignores assistant model fields", () => {
    const derived = deriveSelectionFromMessages([
      {
        info: {
          id: "m1",
          role: "assistant",
          sessionID: "s1",
          providerID: "openai",
          modelID: "gpt-5",
          variant: "high",
        } as never,
        parts: [],
      },
    ]);

    expect(derived).toEqual({ selectedModel: null, selectedAgent: null, variant: undefined });
  });

  test("derives selected model from latest user message selection", () => {
    const derived = deriveSelectionFromMessages([
      {
        info: {
          id: "m1",
          role: "user",
          sessionID: "s1",
          agent: "reviewer",
          model: { providerID: "openai", modelID: "gpt-5" },
          variant: "high",
        } as never,
        parts: [],
      },
      {
        info: {
          id: "m2",
          role: "assistant",
          sessionID: "s1",
          model: { providerID: "anthropic", modelID: "sonnet" },
        } as never,
        parts: [],
      },
    ]);

    expect(derived).toEqual({
      selectedModel: { providerID: "openai", modelID: "gpt-5" },
      selectedAgent: "reviewer",
      variant: "high",
    });
  });
});

describe("createBufferedSessionMessages", () => {
  test("maps buffered messages into message entries", () => {
    const messages = createBufferedSessionMessages({
      messages: {
        m1: {
          info: { id: "m1", role: "assistant", sessionID: "s1" } as never,
          parts: {
            p1: { id: "p1", type: "text", text: "hello", sessionID: "s1" } as never,
          },
        },
      },
      hasMore: false,
      cursor: null,
      complete: true,
    });

    expect(messages).toHaveLength(1);
    expect(messages?.[0]).toMatchObject({
      info: { id: "m1" },
      parts: [{ id: "p1", text: "hello" }],
    });
  });

  test("returns undefined when no buffer exists", () => {
    expect(createBufferedSessionMessages(undefined)).toBeUndefined();
  });
});

describe("createRefreshMessageLimit", () => {
  test("never drops below the default page size", () => {
    expect(createRefreshMessageLimit(1)).toBe(30);
  });

  test("grows with the loaded transcript", () => {
    expect(createRefreshMessageLimit(160)).toBe(168);
  });
});
