import { describe, expect, test } from "vite-plus/test";
import {
  connectionIdFrom,
  formatCommandLine,
  labelFromCommand,
  labelFromUrl,
  parseMcpInput,
  tokenizeCommandLine,
} from "./mcp-input";

describe("tokenizeCommandLine", () => {
  test("splits on whitespace and keeps quoted arguments together", () => {
    expect(tokenizeCommandLine(`npx -y server "My Documents" 'it''s' a\\ b`)).toEqual([
      "npx",
      "-y",
      "server",
      "My Documents",
      "its",
      "a b",
    ]);
  });

  test("round-trips through formatCommandLine", () => {
    const args = ["-y", "@scope/server", "/Users/me/My Files", "it's", ""];
    expect(tokenizeCommandLine(formatCommandLine("npx", args))).toEqual(["npx", ...args]);
  });
});

describe("labels", () => {
  test.each([
    [["npx", "-y", "@modelcontextprotocol/server-filesystem", "/tmp"], "Filesystem"],
    [["uvx", "mcp-server-fetch"], "Fetch"],
    [["pnpm", "dlx", "@upstash/context7-mcp@latest"], "Context7"],
    [["docker", "run", "-i", "--rm", "ghcr.io/github/github-mcp-server"], "Github"],
    [["node", "./build/weather-server.js"], "Weather"],
    [["/usr/local/bin/calendar"], "Calendar"],
  ])("names %j as %s", (tokens, label) => {
    expect(labelFromCommand(tokens)).toBe(label);
  });

  test("names remote servers after their host", () => {
    expect(labelFromUrl("https://mcp.notion.com/mcp")).toBe("Notion");
    expect(labelFromUrl("https://api.example.dev/v1/mcp")).toBe("Example");
    expect(labelFromUrl("http://localhost:3000/mcp")).toBe("Localhost");
  });

  test("derives unique, valid connection ids", () => {
    expect(connectionIdFrom("Google Drive")).toBe("google-drive");
    expect(connectionIdFrom("Notion", ["notion", "notion-2"])).toBe("notion-3");
    expect(connectionIdFrom("✨")).toBe("server");
  });
});

describe("parseMcpInput", () => {
  test("recognises remote endpoints", () => {
    expect(parseMcpInput("  https://mcp.linear.app/mcp ")).toEqual({
      kind: "http",
      url: "https://mcp.linear.app/mcp",
      label: "Linear",
    });
  });

  test("lifts leading environment assignments out of a command", () => {
    expect(parseMcpInput("GITHUB_TOKEN=abc npx -y @acme/github-mcp")).toEqual({
      kind: "stdio",
      commandLine: "npx -y @acme/github-mcp",
      env: [{ key: "GITHUB_TOKEN", value: "abc" }],
      label: "Github",
    });
  });

  test("rejects empty input and URLs with spaces", () => {
    expect(parseMcpInput("   ")).toBeNull();
    expect(parseMcpInput("https://example.com/mcp extra")).toBeNull();
  });
});
