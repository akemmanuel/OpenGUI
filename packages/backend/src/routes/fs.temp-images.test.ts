import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { afterEach, describe, expect, test } from "vite-plus/test";
import { resolveSafeDirectory } from "../host/path-safety.ts";
import type { BackendRequestEnv } from "../http/request-context.ts";
import { HostPathAuthorizer, createLocalPolicyResolver } from "../path-policy/enforcement.ts";
import { registerFsRoutes } from "./fs.ts";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true })));
});

async function temporaryDirectory(prefix: string) {
  const path = await mkdtemp(join(tmpdir(), prefix));
  temporaryDirectories.push(path);
  return path;
}

/** The allowed root is a Project; the scratch dir sits next to it in tmp. */
async function createApp(options: { restricted?: boolean } = {}) {
  const root = await temporaryDirectory("opengui-temp-images-root-");
  const app = new Hono<BackendRequestEnv>();
  app.use("/api/*", async (c, next) => {
    c.set("actor", { type: "local", id: "desktop-local", displayName: "", role: "owner" });
    await next();
  });
  registerFsRoutes(app, {
    env: { allowedRoots: [root], uploadMaxFileBytes: 1024, uploadMaxBatchBytes: 2048 },
    resolveSafeDirectory: (path) => resolveSafeDirectory(path, [root]),
    pathAuthorizer: new HostPathAuthorizer(
      options.restricted
        ? async () => ({
            restricted: true,
            revision: 1,
            shellAllowed: false,
            grants: [{ root, access: "read" }],
            authorizePath: async () => ({ allowed: false, reason: "outside_grants" }),
          })
        : createLocalPolicyResolver([root]),
    ),
  });
  return app;
}

const fileUrl = (path: string) =>
  `http://localhost/api/fs/file?${new URLSearchParams({ path }).toString()}`;

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

describe("temp dir images", () => {
  test("raster images in the OS temp dir render outside the allowed roots", async () => {
    const app = await createApp();
    const scratch = await temporaryDirectory("opengui-temp-images-scratch-");
    await writeFile(join(scratch, "shot.png"), PNG);
    await writeFile(join(scratch, "logo.svg"), "<svg/>");
    await writeFile(join(scratch, "notes.txt"), "secret");
    await symlink(join(scratch, "notes.txt"), join(scratch, "alias.png"));

    const image = await app.request(fileUrl(join(scratch, "shot.png")));
    expect(image.status).toBe(200);
    expect(image.headers.get("content-type")).toBe("image/png");
    expect(Buffer.from(await image.arrayBuffer())).toEqual(PNG);

    for (const name of ["logo.svg", "notes.txt", "alias.png", "missing.png"]) {
      expect((await app.request(fileUrl(join(scratch, name)))).status).toBe(403);
    }
  });

  test("actors with path grants cannot read temp images outside their grants", async () => {
    const app = await createApp({ restricted: true });
    const scratch = await temporaryDirectory("opengui-temp-images-scratch-");
    await writeFile(join(scratch, "shot.png"), PNG);
    expect((await app.request(fileUrl(join(scratch, "shot.png")))).status).toBe(403);
  });
});
