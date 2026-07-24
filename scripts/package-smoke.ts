import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");

async function assertFile(relativePath: string) {
  const info = await stat(path.join(root, relativePath));
  if (!info.isFile() || info.size === 0) throw new Error(`${relativePath} is not a usable file`);
}

async function availablePort() {
  return await new Promise<number>((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") return reject(new Error("No TCP port"));
      server.close(() => resolve(address.port));
    });
  });
}

async function checkArtifacts() {
  for (const file of [
    "dist/index.html",
    "dist-electron/main.js",
    "dist-electron/preload.cjs",
    "dist-electron/backend.js",
    "dist-electron/package.json",
  ]) {
    await assertFile(file);
  }
  const html = await readFile(path.join(root, "dist/index.html"), "utf8");
  const referencedAssets = [...html.matchAll(/(?:src|href)="((?:\.\/|\/)assets\/[^"]+)"/g)].flatMap(
    (match) => {
      const asset = match[1];
      return asset ? [asset.replace(/^(?:\.\/|\/)/, "")] : [];
    },
  );
  if (referencedAssets.length === 0) throw new Error("dist/index.html has no built assets");
  await Promise.all(referencedAssets.map((asset) => assertFile(`dist/${asset}`)));

  const runtimePackage = JSON.parse(
    await readFile(path.join(root, "dist-electron/package.json"), "utf8"),
  ) as { main?: string; type?: string };
  if (runtimePackage.main !== "dist-electron/main.js" || runtimePackage.type !== "module") {
    throw new Error("Electron runtime package metadata does not address the built main entry");
  }

  const dockerfile = await readFile(path.join(root, "Dockerfile"), "utf8");
  if (!dockerfile.includes('ENTRYPOINT ["/usr/local/bin/opengui-entrypoint"]')) {
    throw new Error("Docker entrypoint contract is missing");
  }
  if (!dockerfile.includes('"server/web-server.ts"')) {
    throw new Error("Docker command does not start the Host entrypoint");
  }
  await Promise.all([assertFile("docker/entrypoint.sh"), assertFile("server/web-server.ts")]);
}

async function smokeBuiltHost() {
  const dataDir = await mkdtemp(path.join(tmpdir(), "opengui-package-smoke-"));
  const port = await availablePort();
  const token = "package-smoke-token";
  const child = spawn(process.execPath, [path.join(root, "dist-electron/backend.js")], {
    cwd: root,
    env: {
      ...process.env,
      HOST: "127.0.0.1",
      PORT: String(port),
      OPENGUI_AUTH_TOKEN: token,
      OPENGUI_ALLOWED_ROOTS: dataDir,
      OPENGUI_DATA_DIR: dataDir,
      OPENGUI_SERVER_MODE: "desktop-sidecar",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let diagnostics = "";
  child.stdout?.on("data", (chunk) => (diagnostics += String(chunk)));
  child.stderr?.on("data", (chunk) => (diagnostics += String(chunk)));
  try {
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
      if (child.exitCode !== null) throw new Error(`Built Host exited early: ${diagnostics}`);
      try {
        const response = await fetch(`http://127.0.0.1:${port}/api/health`, {
          headers: { authorization: `Bearer ${token}` },
        });
        if (response.ok) return;
      } catch {
        // The child has not bound its socket yet.
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error(`Built Host did not become healthy: ${diagnostics}`);
  } finally {
    child.kill("SIGTERM");
    await new Promise<void>((resolve) => {
      if (child.exitCode !== null) resolve();
      else child.once("exit", () => resolve());
    });
    await rm(dataDir, { recursive: true, force: true });
  }
}

await checkArtifacts();
await smokeBuiltHost();
console.info(
  "Package smoke passed: static, Electron, Docker, and built Host assumptions are valid",
);
