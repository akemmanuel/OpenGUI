#!/usr/bin/env node
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";

const pkg = process.env.ANDROID_PACKAGE ?? "com.opengui.app";
const port = Number(process.env.DEVTOOLS_PORT ?? 9222);
const outDir = process.env.OUT_DIR ?? "build/waydroid-audit";
mkdirSync(outDir, { recursive: true });
function run(cmd, args) {
  return execFileSync(cmd, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}
function adb(args) {
  return run("adb", args);
}
spawnSync("bash", ["scripts/waydroid-adb-connect.sh"], { stdio: "inherit" });
let pid = "";
try {
  pid = adb(["shell", "pidof", pkg]).split(/\s+/)[0];
} catch {}
if (!pid) {
  adb(["shell", "monkey", "-p", pkg, "-c", "android.intent.category.LAUNCHER", "1"]);
  await new Promise((r) => setTimeout(r, 2500));
  pid = adb(["shell", "pidof", pkg]).split(/\s+/)[0];
}
const sockets = adb(["shell", "cat", "/proc/net/unix"])
  .split("\n")
  .map((l) => l.match(/@(webview_devtools_remote[^\s]*)/)?.[1])
  .filter(Boolean);
const socket = sockets.find((s) => s.includes(pid)) ?? sockets[0];
adb(["forward", `tcp:${port}`, `localabstract:${socket}`]);
const targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
const target = targets.find((t) => t.type === "page") ?? targets[0];
let seq = 0;
const pending = new Map();
const events = [];
const ws = new WebSocket(target.webSocketDebuggerUrl);
ws.addEventListener("message", (e) => {
  const msg = JSON.parse(e.data);
  if (msg.method) events.push(msg);
  if (msg.id && pending.has(msg.id)) {
    pending.get(msg.id)(msg);
    pending.delete(msg.id);
  }
});
await new Promise((res, rej) => {
  ws.addEventListener("open", res, { once: true });
  ws.addEventListener("error", rej, { once: true });
});
function cdp(method, params = {}) {
  const id = ++seq;
  ws.send(JSON.stringify({ id, method, params }));
  return new Promise((res, rej) => {
    pending.set(id, (m) => (m.error ? rej(Error(JSON.stringify(m.error))) : res(m.result)));
    setTimeout(() => rej(Error(`timeout ${method}`)), 10000).unref();
  });
}
async function evalJS(expression) {
  const r = await cdp("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
  return r.result?.value ?? r.result?.description;
}
async function shot(name) {
  const s = await cdp("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
  writeFileSync(`${outDir}/${name}.png`, Buffer.from(s.data, "base64"));
}
async function snapshot(name) {
  const data = await evalJS(
    `(() => ({url:location.href,title:document.title,text:document.body.innerText,active:document.activeElement?.outerHTML,buttons:[...document.querySelectorAll('button,[role=button],a,input,textarea')].map((e,i)=>{const r=e.getBoundingClientRect();return {i,tag:e.tagName,role:e.getAttribute('role'),text:(e.innerText||e.value||e.placeholder||e.ariaLabel||'').trim(),aria:e.getAttribute('aria-label'),rect:{x:r.x,y:r.y,w:r.width,h:r.height},visible:r.width>0&&r.height>0&&getComputedStyle(e).visibility!=='hidden'&&getComputedStyle(e).display!=='none'};}),errors:window.__auditErrors||[]}))()`,
  );
  writeFileSync(`${outDir}/${name}.json`, JSON.stringify(data, null, 2));
  return data;
}
async function clickText(text, name = text.replace(/\W+/g, "_")) {
  const ok = await evalJS(
    `(() => { const t=${JSON.stringify(text)}; const els=[...document.querySelectorAll('button,[role=button],a,[data-slot],input,textarea')].filter(e=>((e.innerText||e.value||e.placeholder||e.ariaLabel||'').trim()).includes(t)); const e=els.find(e=>{const r=e.getBoundingClientRect();return r.width&&r.height;}); if(!e) return false; e.scrollIntoView({block:'center',inline:'center'}); e.click(); return true; })()`,
  );
  await new Promise((r) => setTimeout(r, 1000));
  await shot(name);
  await snapshot(name);
  return ok;
}
await cdp("Runtime.enable");
await cdp("Page.enable");
await cdp("Log.enable");
await evalJS(
  `window.__auditErrors=[]; window.addEventListener('error', e=>__auditErrors.push({type:'error',message:e.message,source:e.filename,line:e.lineno})); window.addEventListener('unhandledrejection', e=>__auditErrors.push({type:'rejection',reason:String(e.reason)}));`,
);
await shot("01_initial");
await snapshot("01_initial");
for (const label of ["Settings", "Code", "New Chat", "Add workspace", "Add", "Toggle Sidebar"]) {
  try {
    console.log(label, await clickText(label));
  } catch (e) {
    console.error(label, e.message);
  }
}
await snapshot("99_final");
writeFileSync(
  `${outDir}/cdp-events.json`,
  JSON.stringify(
    events.filter((e) => ["Runtime.exceptionThrown", "Log.entryAdded"].includes(e.method)),
    null,
    2,
  ),
);
ws.close();
console.log(`Audit artifacts: ${outDir}`);
