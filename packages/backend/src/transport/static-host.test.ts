import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vite-plus/test";
import { contentTypeForPath, serveBuiltFile } from "./static-host.ts";

let originalDirectory: string;
let temporaryDirectory: string;

beforeEach(async () => {
  originalDirectory = process.cwd();
  temporaryDirectory = await mkdtemp(join(tmpdir(), "opengui-static-host-"));
  await mkdir(join(temporaryDirectory, "dist"));
  await writeFile(join(temporaryDirectory, "dist", "index.html"), "<h1>OpenGUI</h1>");
  await writeFile(join(temporaryDirectory, "dist", "app.js"), "export {};");
  process.chdir(temporaryDirectory);
});

afterEach(async () => {
  process.chdir(originalDirectory);
  await rm(temporaryDirectory, { recursive: true });
});

describe("static frontend hosting", () => {
  test("serves known assets and falls back to the SPA for unknown routes", async () => {
    const asset = await serveBuiltFile(new Request("https://host.example/app.js"));
    const route = await serveBuiltFile(new Request("https://host.example/sessions/one"));

    expect(await asset.text()).toBe("export {};");
    expect(asset.headers.get("content-type")).toBe("text/javascript; charset=utf-8");
    expect(await route.text()).toBe("<h1>OpenGUI</h1>");
    expect(contentTypeForPath("image.unknown")).toBe("application/octet-stream");
  });

  test("fails closed to the SPA for malformed URL escapes", async () => {
    const response = await serveBuiltFile(new Request("https://host.example/%E0%A4%A"));

    expect(await response.text()).toBe("<h1>OpenGUI</h1>");
  });
});
