#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const args = new Map();
for (let i = 2; i < process.argv.length; i += 1) {
  const key = process.argv[i];
  if (!key?.startsWith("--")) continue;
  args.set(key.slice(2), process.argv[i + 1]?.startsWith("--") ? "" : (process.argv[++i] ?? ""));
}

const projectDir = args.get("project-dir") || process.env.PROJECT_DIR || process.cwd();
const opencodeBase = args.get("opencode") || process.env.OPENCODE_BASE || "http://127.0.0.1:4096";
const fakePermissionId = args.get("fake-permission") || "per_fake_diagnostic";

function findSidecar() {
  const ps = execFileSync("ps", ["-eww", "-o", "pid=,args="], { encoding: "utf8" });
  const candidates = ps
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.includes("backend.js"))
    .map((line) => Number.parseInt(line.split(/\s+/, 1)[0] ?? "", 10))
    .filter(Number.isFinite);
  for (const pid of candidates.reverse()) {
    try {
      const env = Object.fromEntries(
        readFileSync(`/proc/${pid}/environ`, "utf8")
          .split("\0")
          .filter(Boolean)
          .map((entry) => {
            const idx = entry.indexOf("=");
            return [entry.slice(0, idx), entry.slice(idx + 1)];
          }),
      );
      if (env.PORT && env.OPENGUI_AUTH_TOKEN) {
        return {
          base: `http://${env.HOST || "127.0.0.1"}:${env.PORT}`,
          token: env.OPENGUI_AUTH_TOKEN,
        };
      }
    } catch {
      // ignore inaccessible process
    }
  }
  return null;
}

const sidecar = findSidecar();
const openGuiBase = args.get("opengui") || process.env.OPENGUI_BASE || sidecar?.base;
const token = args.get("token") || process.env.OPENGUI_TOKEN || sidecar?.token;
if (!openGuiBase || !token) {
  console.error("Missing OpenGUI base/token. Pass --opengui http://127.0.0.1:PORT --token TOKEN");
  process.exit(2);
}

async function jsonFetch(url, init = {}) {
  const res = await fetch(url, init);
  const text = await res.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    body = text;
  }
  return { status: res.status, ok: res.ok, body };
}

async function openGui(path, init = {}) {
  const headers = new Headers(init.headers || {});
  headers.set("authorization", `Bearer ${token}`);
  if (init.body && !headers.has("content-type")) headers.set("content-type", "application/json");
  return jsonFetch(`${openGuiBase.replace(/\/+$/, "")}${path}`, { ...init, headers });
}

async function main() {
  console.log(`OpenGUI: ${openGuiBase}`);
  console.log(`OpenCode: ${opencodeBase}`);
  console.log(`Project dir: ${projectDir}`);

  const health = await openGui("/api/health");
  console.log("health", health.status, health.body);

  const ocHealth = await jsonFetch(`${opencodeBase}/global/health`);
  console.log("opencode health", ocHealth.status, ocHealth.body);

  const projects = await openGui("/api/projects");
  const project = projects.body?.value?.find?.(
    (item) => item.path === projectDir || item.canonicalPath === projectDir,
  );
  if (!project) throw new Error(`Project not found for ${projectDir}`);
  console.log("project", { id: project.id, path: project.path });

  const sessions = await openGui(
    `/api/sessions?projectId=${encodeURIComponent(project.id)}&harnessId=opencode`,
  );
  const session =
    sessions.body?.value?.sessions?.find?.((item) => item.status === "running") ??
    sessions.body?.value?.sessions?.[0];
  if (!session) throw new Error(`No opencode sessions for ${project.id}`);
  const frontendSessionId = `opencode:${session.rawId}`;
  console.log("session", { rawId: session.rawId, status: session.status, frontendSessionId });

  const legacyPending = await jsonFetch(
    `${opencodeBase}/permission?directory=${encodeURIComponent(project.path)}`,
  );
  console.log("opencode legacy pending", legacyPending.status, legacyPending.body);

  const apiPermission = await openGui(`/api/permissions/${fakePermissionId}/respond`, {
    method: "POST",
    body: JSON.stringify({
      sessionId: frontendSessionId,
      response: "once",
      harnessId: "opencode",
      projectId: project.id,
    }),
  });
  console.log("OpenGUI /api/permissions fake", apiPermission.status, apiPermission.body);

  const rpcNoDir = await openGui("/api/rpc", {
    method: "POST",
    body: JSON.stringify({
      channel: "opencode:permission",
      args: [session.rawId, fakePermissionId, "once"],
    }),
  });
  console.log("RPC opencode:permission no directory", rpcNoDir.status, rpcNoDir.body);

  const rpcWithDir = await openGui("/api/rpc", {
    method: "POST",
    body: JSON.stringify({
      channel: "opencode:permission",
      args: [session.rawId, fakePermissionId, "once", project.path, undefined],
    }),
  });
  console.log("RPC opencode:permission with directory", rpcWithDir.status, rpcWithDir.body);

  const noDirError = rpcNoDir.body?.value?.error || rpcNoDir.body?.error;
  const apiError = apiPermission.body?.error;
  const withDirOk = rpcWithDir.body?.value?.success === true;

  console.log("\nConclusion:");
  if (
    apiError === "Session connection not found" &&
    noDirError === "Session connection not found" &&
    withDirOk
  ) {
    console.log(
      "ROOT CAUSE PRESENT: permission responses omit directory/workspace when calling opencode:permission.",
    );
    console.log("FIX: pass session project scope directory/workspace through respondPermission.");
    return;
  }
  if (apiPermission.ok && noDirError === "Session connection not found" && withDirOk) {
    console.log("ROUTE FIXED: /api/permissions now reaches directory-scoped opencode connection.");
    console.log(
      "Note: fake permission IDs may still return ok because the SDK does not throw on 404 without throwOnError.",
    );
    return;
  }
  console.log("Unexpected result. Inspect output above.");
  process.exitCode = 1;
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
