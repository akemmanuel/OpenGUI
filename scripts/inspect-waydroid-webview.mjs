#!/usr/bin/env node
import { execFileSync, spawnSync } from "node:child_process";
import { writeFileSync, mkdirSync } from "node:fs";

const pkg = process.env.ANDROID_PACKAGE ?? "com.opengui.app";
const port = Number(process.env.DEVTOOLS_PORT ?? 9222);
const outDir = process.env.OUT_DIR ?? "build/waydroid-inspect";
const launch = process.argv.includes("--launch") || process.env.LAUNCH_APP === "1";
const args = process.argv.slice(2).filter((arg) => arg !== "--launch");
const expr = args.join(" ") || `(() => ({
  href: location.href,
  title: document.title,
  readyState: document.readyState,
  bodyText: document.body?.innerText?.slice(0, 4000) ?? "",
  html: document.documentElement?.outerHTML?.slice(0, 20000) ?? "",
  viewport: { width: innerWidth, height: innerHeight, devicePixelRatio },
  userAgent: navigator.userAgent,
}))()`;

function run(cmd, args, opts = {}) {
  return execFileSync(cmd, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], ...opts }).trim();
}
function adb(args, opts) { return run("adb", args, opts); }

spawnSync("bash", ["scripts/waydroid-adb-connect.sh"], { stdio: "inherit" });

let pid = "";
try {
  pid = adb(["shell", "pidof", pkg]).split(/\s+/)[0];
} catch {}

if (!pid && launch) {
  adb(["shell", "monkey", "-p", pkg, "-c", "android.intent.category.LAUNCHER", "1"]);
  await new Promise((resolve) => setTimeout(resolve, 2000));
  try {
    pid = adb(["shell", "pidof", pkg]).split(/\s+/)[0];
  } catch {}
}

if (!pid) {
  throw new Error(`${pkg} is installed but not running. Open it yourself, or rerun with --launch / LAUNCH_APP=1.`);
}

const sockets = adb(["shell", "cat", "/proc/net/unix"])
  .split("\n")
  .map((l) => l.match(/@(webview_devtools_remote[^\s]*)/)?.[1])
  .filter(Boolean);
const socket = sockets.find((s) => s.includes(pid)) ?? sockets.find((s) => s === `webview_devtools_remote_${pid}`) ?? sockets[0];
if (!socket) throw new Error("No WebView DevTools socket found. Ensure WebView.setWebContentsDebuggingEnabled(true) and the app is open.");

adb(["forward", `tcp:${port}`, `localabstract:${socket}`]);
const targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
const target = targets.find((t) => t.type === "page") ?? targets[0];
if (!target?.webSocketDebuggerUrl) throw new Error("No CDP page target found");

let seq = 0;
const pending = new Map();
const ws = new WebSocket(target.webSocketDebuggerUrl);
ws.addEventListener("message", (event) => {
  const msg = JSON.parse(event.data);
  if (msg.id && pending.has(msg.id)) {
    pending.get(msg.id)(msg);
    pending.delete(msg.id);
  }
});
await new Promise((resolve, reject) => {
  ws.addEventListener("open", resolve, { once: true });
  ws.addEventListener("error", reject, { once: true });
});
function cdp(method, params = {}) {
  const id = ++seq;
  ws.send(JSON.stringify({ id, method, params }));
  return new Promise((resolve, reject) => {
    pending.set(id, (msg) => msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result));
    setTimeout(() => reject(new Error(`CDP timeout: ${method}`)), 10000).unref();
  });
}

await cdp("Runtime.enable");
await cdp("Page.enable");
const evaluated = await cdp("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true });
const result = evaluated.result?.value ?? evaluated.result?.description ?? evaluated;
const screenshot = await cdp("Page.captureScreenshot", { format: "png", captureBeyondViewport: true }).catch(() => null);
ws.close();

mkdirSync(outDir, { recursive: true });
writeFileSync(`${outDir}/targets.json`, JSON.stringify(targets, null, 2));
writeFileSync(`${outDir}/result.json`, JSON.stringify(result, null, 2));
if (result?.html) writeFileSync(`${outDir}/dom.html`, result.html);
if (screenshot?.data) writeFileSync(`${outDir}/screenshot.png`, Buffer.from(screenshot.data, "base64"));

console.log(JSON.stringify({ pkg, pid, socket, port, target: target.url, outDir, result }, null, 2));
