import { mkdir, mkdtemp, rm, truncate, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { afterEach, describe, expect, test } from "vite-plus/test";
import { resolveSafeDirectory } from "../host/path-safety.ts";
import type { BackendRequestEnv } from "../http/request-context.ts";
import { HostPathAuthorizer, createLocalPolicyResolver } from "../path-policy/enforcement.ts";
import { guessTextEncoding, MAX_FILE_PREVIEW_BYTES, registerFsRoutes } from "./fs.ts";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true })));
});

async function createApp(options: { downloadMaxBytes?: number } = {}) {
  const root = await mkdtemp(join(tmpdir(), "opengui-files-panel-"));
  temporaryDirectories.push(root);
  const app = new Hono<BackendRequestEnv>();
  app.use("/api/*", async (c, next) => {
    c.set("actor", { type: "local", id: "desktop-local", displayName: "", role: "owner" });
    await next();
  });
  registerFsRoutes(app, {
    env: {
      allowedRoots: [root],
      uploadMaxFileBytes: 1024,
      uploadMaxBatchBytes: 2048,
      downloadMaxBytes: options.downloadMaxBytes,
    },
    resolveSafeDirectory: (path) => resolveSafeDirectory(path, [root]),
    pathAuthorizer: new HostPathAuthorizer(createLocalPolicyResolver([root])),
  });
  return { app, root };
}

const url = (path: string, params: Record<string, string>) =>
  `http://localhost${path}?${new URLSearchParams(params).toString()}`;

describe("guessTextEncoding", () => {
  test("recognizes UTF-8, legacy single-byte text, and binary content", () => {
    expect(guessTextEncoding(new TextEncoder().encode("<?php echo 'Grüße';\n"))).toBe("utf-8");
    expect(guessTextEncoding(new Uint8Array())).toBe("utf-8");
    // "Grüße" in Windows-1252.
    expect(guessTextEncoding(Uint8Array.from([0x47, 0x72, 0xfc, 0xdf, 0x65, 0x0a]))).toBe(
      "windows-1252",
    );
    expect(guessTextEncoding(Uint8Array.from([0x25, 0x50, 0x44, 0x46, 0x00, 0x01]))).toBeNull();
    expect(
      guessTextEncoding(Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a])),
    ).toBeNull();
    expect(guessTextEncoding(Uint8Array.from([0x41, 0x01, 0x42]))).toBeNull();
    // A multi-byte character cut off by the sniff window is still text.
    expect(guessTextEncoding(new TextEncoder().encode("abc ü").subarray(0, 5))).toBe("utf-8");
  });
});

describe("files panel routes", () => {
  test("lists files with size and date only when asked, folders first", async () => {
    const { app, root } = await createApp();
    await mkdir(join(root, "zeta"));
    await mkdir(join(root, ".git"));
    await writeFile(join(root, "a.txt"), "hello");
    await writeFile(join(root, "file10.md"), "");
    await writeFile(join(root, "file9.md"), "");
    await writeFile(join(root, ".env"), "SECRET=1");
    const modified = new Date("2026-11-01T10:00:00Z");
    await utimes(join(root, "a.txt"), modified, modified);

    const foldersOnly = (await (await app.request(url("/api/fs/list", { path: root }))).json()) as {
      value: { entries: unknown[] };
    };
    expect(foldersOnly.value.entries).toEqual([
      { name: "zeta", path: join(root, "zeta"), type: "dir" },
    ]);

    const withFiles = (await (
      await app.request(url("/api/fs/list", { path: root, files: "1" }))
    ).json()) as {
      value: {
        entries: { name: string; type: string; size?: number; modifiedAt?: number }[];
      };
    };
    expect(withFiles.value.entries.map(({ name, type }) => [name, type])).toEqual([
      ["zeta", "dir"],
      ["a.txt", "file"],
      ["file9.md", "file"],
      ["file10.md", "file"],
    ]);
    expect(withFiles.value.entries[1]).toMatchObject({
      size: 5,
      modifiedAt: modified.getTime(),
    });
    expect(withFiles.value.entries[0]?.size).toBeUndefined();
  });

  test("stat reports size, date and text encoding; relative paths resolve in the project", async () => {
    const { app, root } = await createApp();
    await writeFile(join(root, "contact.php"), "<?php\necho 'hi';\n");
    await writeFile(join(root, "doc.pdf"), Buffer.from([0x25, 0x50, 0x44, 0x46, 0x00, 0xff]));

    const text = await app.request(url("/api/fs/stat", { path: "contact.php", directory: root }));
    expect(text.status).toBe(200);
    expect(((await text.json()) as { value: unknown }).value).toMatchObject({
      path: join(root, "contact.php"),
      name: "contact.php",
      size: 17,
      textEncoding: "utf-8",
    });

    const binary = await app.request(url("/api/fs/stat", { path: join(root, "doc.pdf") }));
    expect(((await binary.json()) as { value: unknown }).value).toMatchObject({
      textEncoding: null,
    });

    expect((await app.request(url("/api/fs/stat", { path: root }))).status).toBe(400);
    const outside = await mkdtemp(join(tmpdir(), "opengui-files-panel-outside-"));
    temporaryDirectories.push(outside);
    await writeFile(join(outside, "secret.txt"), "secret");
    expect(
      (await app.request(url("/api/fs/stat", { path: join(outside, "secret.txt") }))).status,
    ).toBe(403);
  });

  test("text previews read only the requested head of the file", async () => {
    const { app, root } = await createApp();
    await writeFile(join(root, "big.log"), "0123456789".repeat(100));
    const response = await app.request(
      url("/api/fs/file", { path: join(root, "big.log"), maxBytes: "25" }),
    );
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("0123456789012345678901234");
    expect(response.headers.get("content-security-policy")).toContain("sandbox");
  });

  test("downloads stream the whole file as an attachment", async () => {
    const { app, root } = await createApp();
    const content = "x".repeat(300_000);
    await writeFile(join(root, "Übersicht 2026.pdf"), content);
    const response = await app.request(
      url("/api/fs/file", { path: join(root, "Übersicht 2026.pdf"), download: "1" }),
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/octet-stream");
    expect(response.headers.get("content-length")).toBe(String(content.length));
    expect(response.headers.get("content-disposition")).toBe(
      `attachment; filename="_bersicht 2026.pdf"; filename*=UTF-8''%C3%9Cbersicht%202026.pdf`,
    );
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(await response.text()).toBe(content);
  });

  test("an optional download limit refuses larger files", async () => {
    const { app, root } = await createApp({ downloadMaxBytes: 10 });
    await writeFile(join(root, "small.txt"), "0123456789");
    await writeFile(join(root, "large.txt"), "0123456789!");
    const download = (name: string) =>
      app.request(url("/api/fs/file", { path: join(root, name), download: "1" }));
    expect((await download("small.txt")).status).toBe(200);
    expect((await download("large.txt")).status).toBe(413);
  });
  test("PDF previews stream byte ranges beyond the buffered preview limit", async () => {
    const { app, root } = await createApp();
    const path = join(root, "large.pdf");
    await writeFile(path, "%PDF-1.7\n");
    await truncate(path, MAX_FILE_PREVIEW_BYTES + 10);
    const request = (range: string) =>
      app.request(url("/api/fs/file", { path }), { headers: { range } });
    const first = await request("bytes=0-7");
    expect(first.status).toBe(206);
    expect(first.headers.get("content-range")).toBe(`bytes 0-7/${MAX_FILE_PREVIEW_BYTES + 10}`);
    expect(first.headers.get("content-length")).toBe("8");
    expect(await first.text()).toBe("%PDF-1.7");
    const last = await request("bytes=-3");
    expect(last.status).toBe(206);
    expect((await last.arrayBuffer()).byteLength).toBe(3);
    for (const range of ["bytes=5-1", "bytes=999999999-", "bytes=-0", "bytes=", "bytes=1-2,5-6"]) {
      expect((await request(range)).status).toBe(416);
    }
    const full = await app.request(url("/api/fs/file", { path }));
    expect(full.status).toBe(200);
    expect(full.headers.get("content-type")).toBe("application/pdf");
    await full.body?.cancel();
  });
});
