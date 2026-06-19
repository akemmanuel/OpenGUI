import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "@voidzero-dev/vite-plus-test";

const messageBubblePath = join(dirname(fileURLToPath(import.meta.url)), "MessageBubble.tsx");

describe("MessageBubble architecture", () => {
  test("does not subscribe to use-agent-state session or connection hooks", () => {
    const source = readFileSync(messageBubblePath, "utf8");
    expect(source).not.toMatch(/useSessionState/);
    expect(source).not.toMatch(/useConnectionState/);
    expect(source).not.toMatch(/from "@\/hooks\/use-agent-state"/);
  });
});
