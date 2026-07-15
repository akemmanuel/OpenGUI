import { describe, expect, test } from "vite-plus/test";
import type { Command } from "@/protocol/agent-types";
import { decidePromptSubmit } from "@/hooks/use-prompt-submit";

const command = { name: "review" } as Command;

describe("decidePromptSubmit", () => {
  test("skips disabled submits", () => {
    expect(
      decidePromptSubmit({
        value: "Ship it",
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
        disabled: false,
        queueMode: "queue",
        slashInvocation: { commandName: "review", args: "--all", command },
      }),
    ).toEqual({ type: "command", commandName: "review", args: "--all" });
  });

  test("routes normal prompts", () => {
    expect(
      decidePromptSubmit({
        value: "Ship it",
        disabled: false,
        queueMode: "queue",
        slashInvocation: null,
      }),
    ).toEqual({ type: "prompt", text: "Ship it", mode: undefined });
  });

  test("skips while uploading", () => {
    expect(
      decidePromptSubmit({
        value: "Ship it",
        disabled: false,
        isUploading: true,
        queueMode: "queue",
        slashInvocation: null,
      }),
    ).toEqual({ type: "skip" });
  });

  test("passes queue mode while loading", () => {
    expect(
      decidePromptSubmit({
        value: "Follow up",
        disabled: false,
        isLoading: true,
        queueMode: "after-part",
        slashInvocation: null,
      }),
    ).toEqual({ type: "prompt", text: "Follow up", mode: "after-part" });
  });
});
