import { describe, expect, test } from "@voidzero-dev/vite-plus-test";
import { createBackendIdCodec, createHarnessIdCodec } from "./id-codec";

describe("createHarnessIdCodec", () => {
  test("composes and deconstructs frontend session ids through session identity helpers", () => {
    const codec = createHarnessIdCodec("codex");

    expect(codec.compose("raw-session")).toBe("codex:raw-session");
    expect(codec.compose("codex:raw-session")).toBe("codex:raw-session");
    expect(codec.decompose("codex:raw-session")).toBe("raw-session");
    expect(codec.decompose("pi:raw-session")).toBe("pi:raw-session");
  });

  test("matches only ids tagged for its harness", () => {
    const codec = createHarnessIdCodec("pi");

    expect(codec.matches("pi:raw-session")).toBe(true);
    expect(codec.matches("codex:raw-session")).toBe(false);
    expect(codec.matches(null)).toBe(false);
  });

  test("deprecated createBackendIdCodec alias matches createHarnessIdCodec", () => {
    const harness = createHarnessIdCodec("codex");
    const backend = createBackendIdCodec("codex");
    expect(backend.compose("x")).toBe(harness.compose("x"));
    expect(backend.decompose("codex:x")).toBe(harness.decompose("codex:x"));
  });
});
