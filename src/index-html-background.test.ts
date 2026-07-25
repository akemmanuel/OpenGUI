import { readFileSync } from "node:fs";
import { describe, expect, test } from "vite-plus/test";

const indexHtml = readFileSync(new URL("./index.html", import.meta.url), "utf8");

describe("startup background", () => {
  test("keeps the document paint stack on the runtime theme token", () => {
    expect(indexHtml).toContain("background: var(--background, oklch(1 0 0));");
    expect(indexHtml).toContain("background: var(--background, oklch(0.145 0 0));");
    expect(indexHtml).not.toMatch(/\.dark body\s*\{\s*background:\s*oklch\(/);
  });
});
