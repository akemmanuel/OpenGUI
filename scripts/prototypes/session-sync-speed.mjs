#!/usr/bin/env node
/**
 * PROTOTYPE — throwaway session sync speed explorer.
 *
 * Question: for the sidebar projects Blogberg, OpenGUI, astra-chat-cloud-agents, and deepsign,
 * how expensive are the available session-loading strategies, and what would cached-first vs
 * always-sync feel like? This intentionally hits the local OpenGUI backend and prints timings.
 *
 * Run: vp node scripts/prototypes/session-sync-speed.mjs
 * Optional: OPENGUI_BASE_URL=http://127.0.0.1:37865 OPENGUI_AUTH_TOKEN=... vp node ...
 */
import { execFileSync, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import readline from "node:readline";

const PROJECTS = [
  "/home/emmanuel/Code/Blogberg",
  "/home/emmanuel/Code/OpenGUI",
  "/home/emmanuel/Code/astra-chat-cloud-agents",
  "/home/emmanuel/Code/deepsign",
];
const HARNESSES = ["pi", "opencode", "claude-code", "codex"];
const B = "\x1b[1m";
const D = "\x1b[2m";
const R = "\x1b[0m";

function now() {
  return performance.now();
}

function ms(n) {
  return `${Math.round(n).toString().padStart(5)}ms`;
}

function projectKey(path) {
  return `local:${path}`;
}

function readTokenFromProc(pid) {
  try {
    const env = readFileSync(`/proc/${pid}/environ`, "utf8").split("\0");
    return (
      env.find((x) => x.startsWith("OPENGUI_AUTH_TOKEN="))?.slice("OPENGUI_AUTH_TOKEN=".length) ??
      null
    );
  } catch {
    return null;
  }
}

async function waitForHealth(baseUrl, token) {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    try {
      const headers = token ? { authorization: `Bearer ${token}` } : undefined;
      const res = await fetch(`${baseUrl}/api/health`, { headers });
      if (res.ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out waiting for ${baseUrl}/api/health`);
}

async function startManagedBackend() {
  const port = Number(
    process.env.OPENGUI_PROTOTYPE_PORT || 31_000 + Math.floor(Math.random() * 20_000),
  );
  const token = process.env.OPENGUI_AUTH_TOKEN || randomUUID();
  const baseUrl = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, ["--experimental-strip-types", "server/web-server.ts"], {
    cwd: process.cwd(),
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      HOST: "127.0.0.1",
      PORT: String(port),
      NODE_ENV: "development",
      OPENGUI_MODE: "api",
      OPENGUI_AUTH_TOKEN: token,
      OPENGUI_ALLOWED_ROOTS: process.env.OPENGUI_ALLOWED_ROOTS || homedir(),
      OPENGUI_DATA_DIR:
        process.env.OPENGUI_DATA_DIR || join(homedir(), ".config", "OpenGUI", "backend"),
    },
  });
  child.stdout.on("data", (chunk) => {
    if (process.env.OPENGUI_PROTOTYPE_SERVER_LOGS === "1") process.stdout.write(`${D}${chunk}${R}`);
  });
  child.stderr.on("data", (chunk) => {
    if (process.env.OPENGUI_PROTOTYPE_SERVER_LOGS === "1") process.stderr.write(`${D}${chunk}${R}`);
  });
  child.once("exit", (code) => {
    if (code !== 0 && code !== null) console.error(`managed OpenGUI backend exited with ${code}`);
  });
  process.once("exit", () => child.kill());
  process.once("SIGINT", () => {
    child.kill();
    process.exit(130);
  });
  await waitForHealth(baseUrl, token);
  return { baseUrl, token, managed: true };
}

async function discoverBackend() {
  if (process.env.OPENGUI_BASE_URL) {
    return {
      baseUrl: process.env.OPENGUI_BASE_URL.replace(/\/+$/, ""),
      token: process.env.OPENGUI_AUTH_TOKEN || null,
      managed: false,
    };
  }
  if (!process.argv.includes("--use-existing")) return await startManagedBackend();
  const ss = execFileSync("ss", ["-ltnp"], { encoding: "utf8" });
  const ports = [...ss.matchAll(/127\.0\.0\.1:(\d+).*users:\(\("electron",pid=(\d+)/g)].map(
    (m) => ({ port: m[1], pid: m[2] }),
  );
  for (const { port, pid } of ports) {
    const baseUrl = `http://127.0.0.1:${port}`;
    try {
      const res = await fetch(`${baseUrl}/api/health`);
      const json = await res.json();
      if (json?.ok && json?.mode === "desktop-sidecar") {
        return {
          baseUrl,
          token: process.env.OPENGUI_AUTH_TOKEN || readTokenFromProc(pid),
          managed: false,
        };
      }
    } catch {}
  }
  throw new Error(
    "Could not discover OpenGUI desktop-sidecar. Set OPENGUI_BASE_URL and OPENGUI_AUTH_TOKEN.",
  );
}

function makeClient({ baseUrl, token }) {
  async function request(path, init) {
    const headers = new Headers(init?.headers);
    if (token) headers.set("authorization", `Bearer ${token}`);
    if (init?.body && !headers.has("content-type")) headers.set("content-type", "application/json");
    const res = await fetch(`${baseUrl}${path}`, { ...init, headers });
    const text = await res.text();
    let json;
    try {
      json = JSON.parse(text);
    } catch {
      throw new Error(`${res.status} ${text.slice(0, 120)}`);
    }
    if (!res.ok || json.ok === false) throw new Error(json.error || `${res.status}`);
    return json.value;
  }
  return { request };
}

async function timed(label, fn) {
  const start = now();
  try {
    const value = await fn();
    return { label, ok: true, duration: now() - start, value };
  } catch (error) {
    return { label, ok: false, duration: now() - start, error: error.message };
  }
}

async function queryBatch(client, sync) {
  return client.request("/api/sessions/query", {
    method: "POST",
    body: JSON.stringify({
      projects: PROJECTS.map((directory) => ({
        frontendProjectId: projectKey(directory),
        directory,
        workspaceId: "local",
      })),
      harnessIds: HARNESSES,
      sync,
    }),
  });
}

async function runWithConcurrency(jobs, concurrency) {
  const out = Array.from({ length: jobs.length });
  let index = 0;
  await Promise.all(
    Array.from({ length: Math.min(concurrency, jobs.length) }, async () => {
      while (index < jobs.length) {
        const current = index++;
        out[current] = await jobs[current]();
      }
    }),
  );
  return out;
}

async function directPerProjectBackend(client, sync, concurrency) {
  const projects = await client.request("/api/projects");
  const byPath = new Map(projects.map((p) => [p.path, p]));
  const jobs = PROJECTS.flatMap((directory) =>
    HARNESSES.map((harnessId) => async () => {
      const started = now();
      const project = byPath.get(directory);
      if (!project) {
        return {
          directory,
          harnessId,
          sessions: [],
          missingProject: true,
          duration: now() - started,
        };
      }
      const value = await client.request(
        `/api/sessions?projectId=${encodeURIComponent(project.id)}&harnessId=${encodeURIComponent(harnessId)}&sync=${sync ? "true" : "false"}`,
      );
      return { directory, harnessId, sessions: value.sessions ?? [], duration: now() - started };
    }),
  );
  if (concurrency === 1) return runWithConcurrency(jobs, 1);
  return runWithConcurrency(jobs, concurrency);
}

function summarizeQuery(value) {
  const rows = [];
  for (const item of value.items ?? [])
    rows.push({
      directory: item.directory,
      harnessId: item.harnessId,
      count: item.sessions?.length ?? 0,
    });
  return rows;
}

function summarizeDirect(value) {
  return value.map((x) => ({
    directory: x.directory,
    harnessId: x.harnessId,
    count: x.sessions?.length ?? 0,
  }));
}

function printMatrix(rows) {
  const byProject = new Map(
    PROJECTS.map((p) => [p, Object.fromEntries(HARNESSES.map((h) => [h, 0]))]),
  );
  for (const row of rows) {
    if (!byProject.has(row.directory))
      byProject.set(row.directory, Object.fromEntries(HARNESSES.map((h) => [h, 0])));
    byProject.get(row.directory)[row.harnessId] = row.count;
  }
  console.log(`${B}Session counts${R}`);
  console.log(`project                         ${HARNESSES.map((h) => h.padStart(11)).join(" ")}`);
  for (const [directory, counts] of byProject) {
    console.log(
      `${basename(directory).padEnd(30)} ${HARNESSES.map((h) => String(counts[h] ?? 0).padStart(11)).join(" ")}`,
    );
  }
}

async function runOnce(client) {
  const results = [];
  results.push(await timed("batch query cache-only sync:false", () => queryBatch(client, false)));
  results.push(await timed("batch query always-sync sync:true", () => queryBatch(client, true)));
  for (const concurrency of [1, 2, 4, 8, 16]) {
    results.push(
      await timed(`direct GET concurrency=${concurrency} sync:true`, () =>
        directPerProjectBackend(client, true, concurrency),
      ),
    );
  }

  console.clear();
  console.log(`${B}OpenGUI session sync speed prototype${R}`);
  console.log(
    `${D}${new Date().toLocaleTimeString()} — ${PROJECTS.length} projects × ${HARNESSES.length} harnesses${R}\n`,
  );
  for (const result of results) {
    const status = result.ok ? "ok" : "ERR";
    console.log(
      `${B}${ms(result.duration)}${R}  ${status.padEnd(3)}  ${result.label}${result.ok ? "" : ` — ${result.error}`}`,
    );
  }

  const fastestFresh = results
    .filter((r) => r.ok && r.label.includes("sync:true"))
    .sort((a, b) => a.duration - b.duration)[0];
  const cache = results[0];
  const sync = results[1];
  console.log("\n" + `${B}Insights${R}`);
  if (cache?.ok && sync?.ok) {
    console.log(
      `cached-first would paint in ${ms(cache.duration)} then refresh in ${ms(sync.duration)} total batch time`,
    );
    console.log(`always-sync blocks first paint for ${ms(sync.duration)} on this run`);
  }
  if (fastestFresh)
    console.log(
      `fastest fresh strategy here: ${fastestFresh.label} at ${ms(fastestFresh.duration)}`,
    );

  const bestRows = sync?.ok
    ? summarizeQuery(sync.value)
    : fastestFresh?.label.startsWith("direct")
      ? summarizeDirect(fastestFresh.value)
      : [];
  console.log("");
  printMatrix(bestRows);
  console.log(`\n${B}r${R} rerun   ${B}q${R} quit`);
}

const backend = await discoverBackend();
const client = makeClient(backend);
console.log(
  `Using ${backend.baseUrl} ${backend.managed ? "(managed prototype backend)" : backend.token ? "(token discovered)" : "(no token)"}`,
);
await runOnce(client);
if (!process.stdin.isTTY) process.exit(0);
readline.emitKeypressEvents(process.stdin);
if (process.stdin.isTTY) process.stdin.setRawMode(true);
process.stdin.on("keypress", async (_str, key) => {
  if (key.name === "q" || (key.ctrl && key.name === "c")) process.exit(0);
  if (key.name === "r") await runOnce(client);
});
