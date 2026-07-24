import { createServer, type Server, type ServerResponse } from "node:http";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn, execFile, type ChildProcess } from "node:child_process";
import { promisify } from "node:util";
import { terminateDetachedProcessTree } from "./process-tree.ts";

const execFileAsync = promisify(execFile);
const root = process.cwd();
const runId = `${process.pid}-${Date.now()}`;
const browserSession = `opengui-acceptance-${runId}`;
const temporaryRoot = await mkdtemp(join(tmpdir(), "opengui-browser-acceptance-"));
const dataDirectory = join(temporaryRoot, "host-data");
const projectDirectory = join(temporaryRoot, "project");
const logs: string[] = [];
const providerRequests: string[] = [];
const children: ChildProcess[] = [];
let fakeModel: Server | undefined;

function log(message: string) {
  console.log(`[browser-acceptance] ${message}`);
}

async function freePort() {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Could not allocate a port");
  const port = address.port;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

function writeSse(response: ServerResponse, payload: unknown) {
  response.write(`data: ${JSON.stringify(payload)}\n\n`);
}

async function delay(milliseconds: number) {
  await new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function streamFakeCompletion(response: ServerResponse, request: Record<string, any>) {
  response.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
    connection: "keep-alive",
  });
  const messages = Array.isArray(request.messages) ? request.messages : [];
  const lastUser =
    [...messages].reverse().find((message) => message.role === "user")?.content ?? "";
  const lastMessage = messages.at(-1);
  const toolResult = lastMessage?.role === "tool" ? lastMessage.content : undefined;
  const sendDelta = (delta: Record<string, unknown>) =>
    writeSse(response, { choices: [{ delta }] });

  if (/tool journey/i.test(lastUser) && !toolResult) {
    sendDelta({ reasoning_content: "I should inspect the fixture first. " });
    sendDelta({
      tool_calls: [
        {
          index: 0,
          id: "fixture-read",
          function: { name: "read", arguments: JSON.stringify({ path: "notes.txt" }) },
        },
      ],
    });
  } else if (/slow|queue anchor|queued third/i.test(lastUser)) {
    sendDelta({ reasoning_content: "Working through the queued acceptance scenario. " });
    sendDelta({ content: "Slow stream" });
    while (!response.destroyed) {
      await delay(1_000);
    }
    return;
  } else if (toolResult) {
    sendDelta({ reasoning_content: "The fixture read succeeded. " });
    sendDelta({ content: `Tool result observed: ${String(toolResult).slice(0, 200)}` });
  } else {
    sendDelta({ reasoning_content: "Preparing a deterministic response. " });
    sendDelta({ content: `Echo: ${lastUser}` });
  }
  response.write("data: [DONE]\n\n");
  response.end();
}

async function startFakeModel(port: number) {
  fakeModel = createServer((request, response) => {
    providerRequests.push(`${request.method ?? "UNKNOWN"} ${request.url ?? ""}`);
    if (request.method !== "POST" || !request.url?.startsWith("/v1/chat/completions")) {
      console.error(`[browser-acceptance] fake provider rejected ${request.method} ${request.url}`);
      response.writeHead(404).end();
      return;
    }
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk) => (body += chunk));
    request.on("end", () => {
      void streamFakeCompletion(response, JSON.parse(body) as Record<string, unknown>).catch(
        (error) => response.destroy(error as Error),
      );
    });
  });
  await new Promise<void>((resolve, reject) => {
    fakeModel!.once("error", reject);
    fakeModel!.listen(port, "127.0.0.1", resolve);
  });
}

function startDevelopmentStack(frontendPort: number, backendPort: number) {
  const child = spawn(
    "pnpm",
    ["vp", "dev", "--host", "127.0.0.1", "--port", String(frontendPort), "--strictPort"],
    {
      cwd: root,
      detached: process.platform !== "win32",
      env: {
        ...process.env,
        HOST: "127.0.0.1",
        OPENGUI_WEB_BACKEND_HOST: "127.0.0.1",
        OPENGUI_WEB_BACKEND_PORT: String(backendPort),
        OPENGUI_DATA_DIR: dataDirectory,
        OPENGUI_ALLOWED_ROOTS: projectDirectory,
        OPENGUI_IDENTITY_MODE: "remote",
        OPENGUI_PATH_GRANTS: "enforced",
        OPENGUI_CORS_ORIGIN: `http://127.0.0.1:${frontendPort}`,
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  const capture = (chunk: Buffer) => {
    const text = chunk.toString();
    logs.push(text);
    if (process.env.OPENGUI_E2E_VERBOSE === "1") process.stdout.write(text);
  };
  child.stdout?.on("data", capture);
  child.stderr?.on("data", capture);
  children.push(child);
}

async function waitForUrl(url: string, timeoutMilliseconds = 20_000) {
  const deadline = Date.now() + timeoutMilliseconds;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {}
    await delay(150);
  }
  throw new Error(`Timed out waiting for ${url}\n${logs.join("").slice(-4000)}`);
}

async function browser(...arguments_: string[]) {
  const result = await execFileAsync(
    "agent-browser",
    ["--session", browserSession, ...arguments_],
    {
      cwd: root,
      maxBuffer: 4 * 1024 * 1024,
    },
  );
  return result.stdout.trim();
}

async function find(
  kind: "label" | "placeholder" | "text" | "role",
  value: string,
  action: string,
  actionValue?: string,
) {
  const arguments_ = ["find", kind];
  if (kind === "role") arguments_.push(value, action, "--name", actionValue ?? "", "--exact");
  else arguments_.push(value, action, ...(actionValue === undefined ? [] : [actionValue]));
  await browser(...arguments_);
}

async function waitForText(text: string, timeoutMilliseconds = 15_000) {
  await browser("wait", "--text", text, "--timeout", String(timeoutMilliseconds));
}

async function body() {
  return await browser("get", "text", "body");
}

async function expectText(text: string) {
  const content = await body();
  if (!content.includes(text)) throw new Error(`Expected page text ${JSON.stringify(text)}`);
}

async function clickButton(name: string) {
  await find("role", "button", "click", name);
}

async function clickSnapshotControl(name: string) {
  const snapshot = await browser("snapshot", "-i");
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  const reference = snapshot.match(
    new RegExp(`(?:button|menuitem) "${escaped}" \\[ref=(e\\d+)\\]`, "u"),
  )?.[1];
  if (!reference) throw new Error(`Browser control not found in snapshot: ${name}`);
  await browser("click", `@${reference}`);
}

async function fillLabel(label: string, value: string) {
  await find("label", label, "fill", value);
}

async function fillPrompt(value: string) {
  await find("placeholder", "Message...", "fill", value);
}

async function expectBrowserInvariant(label: string, expression: string) {
  const result = await browser("eval", expression);
  if (result !== "true") throw new Error(`${label} failed (browser result: ${result})`);
}

async function auditAccessibleResponsiveSurface(width: number, height: number) {
  await browser("set", "viewport", String(width), String(height));
  await expectBrowserInvariant(
    `${width}x${height} horizontal overflow`,
    "document.documentElement.scrollWidth <= window.innerWidth + 1",
  );
  await expectBrowserInvariant(
    `${width}x${height} accessible interactive names`,
    `Array.from(document.querySelectorAll('button,a[href],input,textarea,select')).filter((element) => {
      const style = getComputedStyle(element);
      if (style.display === 'none' || style.visibility === 'hidden' || element.closest('[aria-hidden=true]') || element.getClientRects().length === 0) return false;
      const labelledBy = element.getAttribute('aria-labelledby');
      const labelledText = labelledBy ? labelledBy.split(/\\s+/).map((id) => document.getElementById(id)?.textContent ?? '').join(' ') : '';
      const explicitLabel = Array.from(element.labels ?? []).map((label) => label.textContent ?? '').join(' ');
      return !(element.getAttribute('aria-label') || labelledText.trim() || explicitLabel.trim() || element.textContent?.trim() || element.getAttribute('title') || element.getAttribute('placeholder'));
    }).length === 0`,
  );
}

async function finishSetup(modelPort: number) {
  await waitForText("Set up this Host");
  await fillLabel("Username", "acceptance_owner");
  await fillLabel("Email", "acceptance-owner@example.com");
  await fillLabel("Password", "acceptance-password");
  await fillLabel("Confirm password", "acceptance-password");
  await clickButton("Create owner account");

  await waitForText("Connect a model");
  await fillLabel("Base URL", `http://127.0.0.1:${modelPort}/v1`);
  await fillLabel("API key", "fixture-key");
  await fillLabel("Model", "fixture-model");
  await clickButton("Continue");

  await waitForText("Choose where new chats start");
  await clickButton("Browse");
  await waitForText("Open Project");
  await clickButton("Open project");
  await delay(300);
  await clickButton("Continue");
  await waitForText("You're ready");
  await clickButton("Open OpenGUI");
}

async function connectProject() {
  await clickButton("Add project");
  await waitForText("Open Project");
  await clickButton("Open project");
  await browser("wait", "--fn", "!document.querySelector('[data-slot=dialog-content]')");
  await waitForText("project");
  await clickButton("New session");
  const content = await body();
  if (!content.includes("fixture-model")) {
    await clickButton("Choose model");
    await waitForText("fixture-model");
    await find("text", "fixture-model", "click", undefined);
  }
}

async function sendAndWait(prompt: string, expected: string) {
  await fillPrompt(prompt);
  await clickButton("Send message");
  await waitForText(expected, 20_000);
}

async function runJourneys(frontendUrl: string, modelPort: number) {
  log("first launch, fresh owner identity, model setup, and Host folder selection");
  await browser("open", frontendUrl);
  await browser("set", "viewport", "1440", "900");
  await finishSetup(modelPort);

  log("connect Project and create the first Session");
  await connectProject();

  log("stream reasoning, text, and a real read tool call through the fake provider");
  await sendAndWait("Tool journey: read the fixture", "Tool result observed:");
  await expectText("fixture content from the isolated project");
  await expectText("Thinking");
  await browser("find", "first", "summary", "click");
  await expectText("I should inspect the fixture first.");

  log("rename Session through the sidebar's public interaction seam");
  await clickButton("Pin to top");
  await find("text", "Rename", "click", undefined);
  await delay(100);
  await browser("fill", "input[value='Tool journey: read the fixture']", "Acceptance Session");
  await browser("press", "Enter");
  await waitForText("Acceptance Session");

  log("queue, edit, reorder, send-now, and abort while a Run streams");
  await fillPrompt("Slow queue anchor");
  await clickButton("Send message");
  await waitForText("Slow stream", 10_000);
  await find("placeholder", "Queue a message...", "fill", "queued second");
  await browser("click", "button[title='Queue']");
  await browser(
    "wait",
    "--fn",
    "document.querySelector('[data-slot=prompt-box-textarea]')?.value === ''",
  );
  await find("placeholder", "Queue a message...", "fill", "queued third");
  await browser("click", "button[title='Queue']");
  await browser(
    "wait",
    "--fn",
    "document.querySelectorAll(\"button[aria-label='More queued prompt actions']\").length === 2",
  );

  await find("text", "queued second", "hover", undefined);
  await browser("click", "button[aria-label='More queued prompt actions']");
  await delay(100);
  await browser(
    "eval",
    "Array.from(document.querySelectorAll('button')).find((button) => button.textContent?.trim() === 'Edit')?.click()",
  );
  await delay(100);
  await browser("fill", "input[value^='queued']", "queued prompt edited");
  await browser("press", "Enter");
  await waitForText("queued prompt edited");

  await find("text", "queued prompt edited", "hover", undefined);
  await browser("click", "button[aria-label='More queued prompt actions']");
  await delay(100);
  await clickSnapshotControl("Move to bottom");
  await find("text", "queued third", "hover", undefined);
  await browser("click", "button[aria-label='Send now']");
  await waitForText("Slow stream", 10_000);
  await browser("click", "button[title='Stop']");
  await delay(500);
  await expectText("queued prompt edited");

  log("refresh/reconnect and Host persistence");
  await browser("reload");
  await waitForText("Acceptance Session", 20_000);
  await waitForText("Tool result observed:", 20_000);

  log("settings/provider persistence and keyboard focus");
  await clickButton("Settings");
  await waitForText("Manage app preferences and providers for active workspace.");
  await find("role", "tab", "click", "Providers");
  await expectText("fixture-model");
  await browser("press", "Tab");

  log("mobile viewport and browser back from Settings");
  await browser("set", "viewport", "390", "844");
  await clickButton("Back");
  await clickButton("Toggle Sidebar");
  await waitForText("Acceptance Session");

  log("responsive, translated, reduced-motion, and large-text DOM invariants");
  await browser("set", "media", "light", "reduced-motion");
  await expectBrowserInvariant(
    "reduced motion",
    `Array.from(document.querySelectorAll('*')).every((element) => {
      const style = getComputedStyle(element);
      const milliseconds = (value) => Math.max(...value.split(',').map((part) => {
        const text = part.trim();
        return Number.parseFloat(text || '0') * (text.endsWith('ms') ? 1 : 1000);
      }));
      return milliseconds(style.animationDuration) <= 1 && milliseconds(style.transitionDuration) <= 1;
    })`,
  );
  for (const [width, height] of [
    [320, 568],
    [768, 1024],
    [1440, 900],
    [720, 450],
  ]) {
    await auditAccessibleResponsiveSurface(width!, height!);
  }
  for (const language of ["de", "es"]) {
    await browser(
      "eval",
      `localStorage.setItem('opengui:web:settings:opengui:language', '${language}')`,
    );
    await browser("reload");
    await waitForText("Tool result observed:", 20_000);
    await expectBrowserInvariant(
      `${language} document language`,
      `document.documentElement.lang === '${language}'`,
    );
    await auditAccessibleResponsiveSurface(390, 844);
  }
  await browser("eval", "localStorage.setItem('opengui:web:settings:opengui:language', 'en')");
  await browser("reload");
  await waitForText("Tool result observed:", 20_000);

  log("delete Session with confirmation");
  await browser("set", "viewport", "1440", "900");
  await browser("eval", "window.confirm = () => true");
  await find("text", "Acceptance Session", "hover", undefined);
  await browser("eval", "document.querySelector(\"button[aria-label='Pin to top']\")?.click()");
  await delay(100);
  await browser(
    "eval",
    "Array.from(document.querySelectorAll('[role=menuitem]')).find((item) => item.textContent?.includes('Delete session'))?.click()",
  );
  await delay(500);
  const content = await body();
  if (content.includes("Acceptance Session")) throw new Error("Deleted Session remained visible");

  const errors = await browser("errors");
  if (errors && !/No page errors/i.test(errors)) throw new Error(`Browser errors:\n${errors}`);
}

async function cleanup() {
  await browser("close").catch(() => undefined);
  for (const child of children.reverse()) {
    if (child.exitCode !== null || !child.pid) continue;
    await terminateDetachedProcessTree(child.pid);
  }
  await delay(250);
  for (const child of children) {
    if (child.exitCode !== null || !child.pid) continue;
    await terminateDetachedProcessTree(child.pid, { force: true });
  }
  if (fakeModel) {
    fakeModel.closeAllConnections();
    await new Promise<void>((resolve) => fakeModel!.close(() => resolve()));
  }
  await rm(temporaryRoot, { recursive: true, force: true });
}

try {
  await Promise.all([mkdir(dataDirectory), mkdir(projectDirectory)]);
  await writeFile(
    join(projectDirectory, "notes.txt"),
    "fixture content from the isolated project\n",
  );
  const [modelPort, backendPort, frontendPort] = await Promise.all([
    freePort(),
    freePort(),
    freePort(),
  ]);
  await startFakeModel(modelPort);
  startDevelopmentStack(frontendPort, backendPort);
  const frontendUrl = `http://127.0.0.1:${frontendPort}`;
  await waitForUrl(frontendUrl);
  await runJourneys(frontendUrl, modelPort);
  log("PASS: deterministic full-stack browser acceptance completed");
} catch (error) {
  const screenshot = join(tmpdir(), `opengui-browser-acceptance-${runId}.png`);
  await browser("screenshot", screenshot, "--full").catch(() => undefined);
  console.error(`[browser-acceptance] FAIL (screenshot: ${screenshot})`);
  console.error(error);
  console.error(logs.join("").slice(-6000));
  console.error(`[browser-acceptance] provider requests: ${providerRequests.join(", ")}`);
  process.exitCode = 1;
} finally {
  await cleanup();
}
