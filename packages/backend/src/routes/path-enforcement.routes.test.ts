import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { afterEach, describe, expect, test } from "vite-plus/test";
import type { DurableActor, ExecutionPolicyResolver } from "@opengui/harness";
import { resolveSafeDirectory } from "../host/path-safety.ts";
import type { BackendRequestEnv } from "../http/request-context.ts";
import type { Actor } from "../identity/types.ts";
import { createEffectivePathPolicy } from "../path-policy/path-policy.ts";
import { HostPathAuthorizer } from "../path-policy/enforcement.ts";
import { registerFsRoutes } from "./fs.ts";
import { registerHostTransportRoutes } from "./host-transport.ts";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true })));
});

describe("filesystem and duplicate RPC path enforcement", () => {
  test("covers no-grant, read/write grants, roots, search, RPC, upload, prefix, and symlink paths", async () => {
    const root = await mkdtemp(join(tmpdir(), "opengui-route-enforcement-"));
    temporaryDirectories.push(root);
    const granted = join(root, "project");
    const sibling = join(root, "project-private");
    await Promise.all([mkdir(granted), mkdir(sibling)]);
    await mkdir(join(granted, "child"));
    await writeFile(join(granted, "visible.txt"), "visible");
    await writeFile(join(sibling, "secret.txt"), "secret");
    await symlink(sibling, join(granted, "escape"), "dir");

    const actor: Actor = {
      type: "user",
      id: "member",
      displayName: "Member",
      role: "member",
    };
    let access: "none" | "read" | "write" = "none";
    const resolver: ExecutionPolicyResolver = async (_actor: DurableActor | undefined) =>
      createEffectivePathPolicy({
        revision: access === "none" ? 1 : 2,
        restricted: true,
        allowedRoots: [root],
        grants: access === "none" ? [] : [{ root: granted, access }],
      });
    const pathAuthorizer = new HostPathAuthorizer(resolver);
    const app = new Hono<BackendRequestEnv>();
    app.use("/api/*", async (c, next) => {
      c.set("actor", actor);
      await next();
    });
    registerFsRoutes(app, {
      env: { allowedRoots: [root], uploadMaxFileBytes: 1024, uploadMaxBatchBytes: 2048 },
      resolveSafeDirectory: (path) => resolveSafeDirectory(path, [root]),
      pathAuthorizer,
    });
    registerHostTransportRoutes(app, {
      env: {
        allowedRoots: [root],
        serverMode: "api-only",
        servesFrontend: false,
        authToken: "",
      },
      ready: Promise.resolve(),
      getHost: async () => ({}) as never,
      resolveSafeDirectory: (path) => resolveSafeDirectory(path, [root]),
      pathAuthorizer,
      pathGrantsEnforced: true,
    });
    const requestJson = async (url: string) =>
      (await (await app.request(url)).json()) as { value: unknown };

    expect((await requestJson("http://localhost/api/fs/roots")).value).toEqual([]);
    expect((await requestJson("http://localhost/api/capabilities")).value).toMatchObject({
      uploads: false,
    });
    expect(
      (await app.request(`http://localhost/api/fs/list?path=${encodeURIComponent(granted)}`))
        .status,
    ).toBe(403);
    const noGrantForm = new FormData();
    noGrantForm.append("directory", granted);
    noGrantForm.append("files", new File(["content"], "file.txt"));
    expect(
      (
        await app.request("http://localhost/api/fs/upload", {
          method: "POST",
          body: noGrantForm,
        })
      ).status,
    ).toBe(403);

    access = "read";
    expect((await requestJson("http://localhost/api/fs/roots")).value).toEqual([granted]);
    expect((await requestJson("http://localhost/api/capabilities")).value).toMatchObject({
      uploads: false,
    });
    expect(
      (await requestJson(`http://localhost/api/fs/list?path=${encodeURIComponent(granted)}`))
        .value as {
        path: string;
        parent: string | null;
        roots: string[];
        entries: { name: string; path: string }[];
      },
    ).toEqual({
      path: granted,
      parent: null,
      roots: [granted],
      entries: [{ name: "child", path: join(granted, "child"), type: "dir" }],
    });
    expect(
      await (
        await app.request(
          `http://localhost/api/fs/file?path=${encodeURIComponent(join(granted, "visible.txt"))}`,
        )
      ).text(),
    ).toBe("visible");
    expect(
      await (
        await app.request(
          `http://localhost/api/fs/search?directory=${encodeURIComponent(granted)}&query=visible`,
        )
      ).json(),
    ).toMatchObject({ ok: true, value: [expect.stringContaining("visible.txt")] });

    const rpc = (channel: string, args: unknown[]) =>
      app.request("http://localhost/api/rpc", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ channel, args }),
      });
    expect((await rpc("files:find", [granted, "visible"])).status).toBe(200);
    expect((await rpc("files:find", [sibling, "secret"])).status).toBe(403);
    expect((await rpc("platform:homeDir", [])).status).toBe(403);
    expect(
      (await app.request(`http://localhost/api/fs/list?path=${encodeURIComponent(sibling)}`))
        .status,
    ).toBe(403);
    expect(
      (
        await app.request(
          `http://localhost/api/fs/file?path=${encodeURIComponent(join(granted, "escape", "secret.txt"))}`,
        )
      ).status,
    ).toBe(403);

    const readForm = new FormData();
    readForm.append("directory", granted);
    readForm.append("files", new File(["content"], "file.txt"));
    expect(
      (await app.request("http://localhost/api/fs/upload", { method: "POST", body: readForm }))
        .status,
    ).toBe(403);

    access = "write";
    const form = new FormData();
    form.append("directory", granted);
    form.append("files", new File(["content"], "file.txt"));
    const uploadResponse = await app.request("http://localhost/api/fs/upload", {
      method: "POST",
      body: form,
    });
    expect(uploadResponse.status).toBe(200);
    const uploaded = ((await uploadResponse.json()) as { value: string[] }).value[0]!;
    expect(uploaded.startsWith(join(granted, ".opengui-uploads"))).toBe(true);
    expect(await readFile(uploaded, "utf8")).toBe("content");
    expect((await requestJson("http://localhost/api/capabilities")).value).toMatchObject({
      permissions: true,
      uploads: true,
    });
  });
});
