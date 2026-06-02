import { describe, expect, test } from "@voidzero-dev/vite-plus-test";
import type { Command } from "@opencode-ai/sdk/v2/client";
import { decidePromptSubmit } from "@/hooks/use-prompt-submit";

const command = { name: "review" } as Command;

describe("decidePromptSubmit", () => {
  test("skips disabled submits", () => {
    expect(
      decidePromptSubmit({
        value: "Ship it",
        imagePreviews: [],
        disabled: true,
        queueMode: "queue",
        slashInvocation: null,
      }),
    ).toEqual({ type: "skip" });
  });

  test("skips empty submits", () => {
    expect(
      decidePromptSubmit({
        value: "   ",
        imagePreviews: [],
        disabled: false,
        queueMode: "queue",
        slashInvocation: null,
      }),
    ).toEqual({ type: "skip" });
  });

  test("routes slash commands", () => {
    expect(
      decidePromptSubmit({
        value: "/review --all",
        imagePreviews: [],
        disabled: false,
        queueMode: "queue",
        slashInvocation: { commandName: "review", args: "--all", command },
      }),
    ).toEqual({ type: "command", commandName: "review", args: "--all" });
  });

  test("routes normal prompts with images", () => {
    expect(
      decidePromptSubmit({
        value: "Ship it",
        imagePreviews: ["image-data"],
        disabled: false,
        queueMode: "queue",
        slashInvocation: null,
      }),
    ).toEqual({ type: "prompt", text: "Ship it", images: ["image-data"], mode: undefined });
  });

  test("passes queue mode while loading", () => {
    expect(
      decidePromptSubmit({
        value: "Follow up",
        imagePreviews: [],
        disabled: false,
        isLoading: true,
        queueMode: "after-part",
        slashInvocation: null,
      }),
    ).toEqual({ type: "prompt", text: "Follow up", images: undefined, mode: "after-part" });
  });
});
