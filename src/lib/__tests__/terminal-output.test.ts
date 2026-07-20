import { describe, expect, test } from "vite-plus/test";
import { looksLikeTerminalOutput, normalizeTerminalOutput } from "../terminal-output";

describe("terminal output", () => {
  test("detects control sequences and box drawing", () => {
    expect(looksLikeTerminalOutput("plain text")).toBe(false);
    expect(looksLikeTerminalOutput("\u001b[31mred")).toBe(true);
    expect(looksLikeTerminalOutput("┌──┐")).toBe(true);
  });

  test("applies carriage returns and cursor movement", () => {
    expect(normalizeTerminalOutput("progress 10%\rprogress 90%")).toBe("progress 90%");
    expect(normalizeTerminalOutput("abc\u001b[2DX")).toBe("aXc");
    expect(normalizeTerminalOutput("a\tX")).toBe("a   X");
  });

  test("strips styling and terminal title sequences", () => {
    expect(normalizeTerminalOutput("\u001b[31mred\u001b[0m")).toBe("red");
    expect(normalizeTerminalOutput("\u001b]0;title\u0007body")).toBe("body");
  });

  test("supports erase-line and clear-screen operations", () => {
    expect(normalizeTerminalOutput("obsolete\u001b[2Knew")).toBe("new");
    expect(normalizeTerminalOutput("old\nnew\u001b[2Jfresh")).toBe("fresh");
  });
});
