import { describe, expect, test } from "vite-plus/test";
import type { Command } from "@/protocol/harness-types";
import { parseSlashCommand } from "@/hooks/use-slash-command-input";

const commands = [{ name: "review" }, { name: "compact" }] as Command[];

describe("parseSlashCommand", () => {
  test("returns null for normal prompts", () => {
    expect(parseSlashCommand("review this", commands)).toBeNull();
  });

  test("parses a slash command without args", () => {
    expect(parseSlashCommand("/compact", commands)).toEqual({
      commandName: "compact",
      args: "",
      command: commands[1],
    });
  });

  test("parses a slash command with args", () => {
    expect(parseSlashCommand("/review --all files", commands)).toEqual({
      commandName: "review",
      args: "--all files",
      command: commands[0],
    });
  });

  test("returns null for unknown slash commands", () => {
    expect(parseSlashCommand("/missing nope", commands)).toBeNull();
  });
});
