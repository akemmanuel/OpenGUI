import { describe, expect, test } from "vite-plus/test";
import {
  coerceHarnessModelRef,
  coerceVariant,
  parsePiDaemonRpcArgs,
  parsePiProjectTargetArg,
  parsePiPromptArgs,
  parsePiStartSessionInput,
} from "../pi-bridge-rpc.ts";

describe("pi-bridge-rpc", () => {
  describe("parsePiStartSessionInput", () => {
    test("returns empty object for non-record input", () => {
      expect(parsePiStartSessionInput(null)).toEqual({});
      expect(parsePiStartSessionInput(undefined)).toEqual({});
      expect(parsePiStartSessionInput("x")).toEqual({});
      expect(parsePiStartSessionInput([])).toEqual({});
    });

    test("narrows record fields and coerces model", () => {
      const input = {
        directory: "/repo",
        workspaceId: "w1",
        title: "T",
        text: "hello",
        images: ["a.png"],
        model: { providerID: "openai", modelID: "gpt-4" },
        agent: "default",
        variant: "  fast  ",
      };
      expect(parsePiStartSessionInput(input)).toEqual({
        directory: "/repo",
        workspaceId: "w1",
        title: "T",
        text: "hello",
        images: ["a.png"],
        model: {
          providerID: "openai",
          modelID: "gpt-4",
          provider: "openai",
          modelId: "gpt-4",
        },
        agent: "default",
        variant: "fast",
      });
    });

    test("ignores non-string scalar fields", () => {
      expect(
        parsePiStartSessionInput({
          directory: 1,
          title: true,
          agent: {},
        }),
      ).toEqual({
        directory: undefined,
        workspaceId: undefined,
        title: undefined,
        text: undefined,
        images: undefined,
        model: undefined,
        agent: undefined,
        variant: undefined,
      });
    });
  });

  describe("parsePiPromptArgs", () => {
    test("returns empty object when no record and fewer than 8 positional args", () => {
      expect(parsePiPromptArgs()).toEqual({});
      expect(parsePiPromptArgs("only-id")).toEqual({});
    });

    test("parses eight positional arguments", () => {
      expect(
        parsePiPromptArgs(
          "sess-1",
          "prompt",
          ["img"],
          { provider: "anthropic", modelId: "sonnet" },
          "agent-a",
          "variant-b",
          "/dir",
          "ws",
        ),
      ).toEqual({
        sessionId: "sess-1",
        text: "prompt",
        images: ["img"],
        model: {
          providerID: "anthropic",
          modelID: "sonnet",
          provider: "anthropic",
          modelId: "sonnet",
        },
        agent: "agent-a",
        variant: "variant-b",
        directory: "/dir",
        workspaceId: "ws",
      });
    });

    test("parses single object argument", () => {
      expect(
        parsePiPromptArgs({
          sessionId: "s",
          text: "t",
          model: { providerID: "p", modelID: "m" },
          variant: "",
        }),
      ).toEqual({
        sessionId: "s",
        text: "t",
        images: undefined,
        model: {
          providerID: "p",
          modelID: "m",
          provider: "p",
          modelId: "m",
        },
        agent: undefined,
        variant: undefined,
        directory: undefined,
        workspaceId: undefined,
      });
    });
  });

  describe("coerceHarnessModelRef", () => {
    test("returns undefined for invalid or empty model", () => {
      expect(coerceHarnessModelRef(null)).toBeUndefined();
      expect(coerceHarnessModelRef({})).toBeUndefined();
      expect(coerceHarnessModelRef("x")).toBeUndefined();
    });

    test("normalizes provider/model id aliases", () => {
      expect(coerceHarnessModelRef({ provider: "a", modelId: "b" })).toEqual({
        providerID: "a",
        modelID: "b",
        provider: "a",
        modelId: "b",
      });
    });
  });

  describe("parsePiProjectTargetArg", () => {
    test("unwraps object target from PiDaemonClient", () => {
      expect(parsePiProjectTargetArg([{ directory: "/repo", workspaceId: "local" }])).toEqual({
        directory: "/repo",
        workspaceId: "local",
      });
    });

    test("accepts positional directory and workspaceId", () => {
      expect(parsePiProjectTargetArg(["/repo", "ws-1"])).toEqual({
        directory: "/repo",
        workspaceId: "ws-1",
      });
    });
  });

  describe("parsePiDaemonRpcArgs getProviders", () => {
    test("normalizes single-object args for daemon RPC", () => {
      const normalized = parsePiDaemonRpcArgs("getProviders", [
        { directory: "/home/user/proj", workspaceId: "local" },
      ]);
      expect(normalized).toEqual([{ directory: "/home/user/proj", workspaceId: "local" }]);
    });
  });

  describe("coerceVariant", () => {
    test("trims and drops empty strings", () => {
      expect(coerceVariant("  x  ")).toBe("x");
      expect(coerceVariant("   ")).toBeUndefined();
      expect(coerceVariant(undefined)).toBeUndefined();
      expect(coerceVariant(42)).toBeUndefined();
    });
  });
});
