import { execFile, spawn, type ChildProcess } from "node:child_process";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { createServer, type Server, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { responsiveAuditExpression, type ResponsiveAuditFinding } from "./responsive-audit.ts";
import { terminateDetachedProcessTree } from "./process-tree.ts";

const execFileAsync = promisify(execFile);
const root = process.cwd();
const runId = `${process.pid}-${Date.now()}`;
const temporaryRoot = await mkdtemp(join(tmpdir(), "opengui-responsive-"));
const dataDirectory = join(temporaryRoot, "host-data");
const projectDirectory = join(
  temporaryRoot,
  "project-with-an-intentionally-very-long-directory-name-for-responsive-regression",
);
const browserSessions = ["owner", "member", "public", "error"].map(
  (name) => `opengui-responsive-${name}-${runId}`,
);
const children: ChildProcess[] = [];
const logs: string[] = [];
let fakeModel: Server | undefined;

type AuditCase = {
  width: number;
  height: number;
  textScale: number;
  dpr: number;
  coarsePointer: boolean;
  safeArea: { top: number; right: number; bottom: number; left: number };
};

function seededAuditCases(seed: number): AuditCase[] {
  let state = seed >>> 0;
  const random = () => {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
    return state / 0x1_0000_0000;
  };
  const widths = [280, 320, 390, 768, 844, 1024, 1200];
  while (widths.length < 11) widths.push(280 + Math.floor(random() * 921));
  return widths.map((width, index) => {
    const shortLandscape = index === 0 || index === 4 || index === 8;
    const height = shortLandscape
      ? [240, 280, 320][index % 3]!
      : [480, 568, 667, 844, 900, 1024][Math.floor(random() * 6)]!;
    const textScale = [1, 1.25, 1.5, 1.75, 2][index % 5]!;
    const inset = index % 4 === 0;
    return {
      width,
      height,
      textScale,
      dpr: [1, 1.5, 2, 3][index % 4]!,
      coarsePointer: index % 3 !== 2,
      safeArea: inset
        ? { top: 32, right: 18, bottom: 28, left: 18 }
        : { top: 0, right: 0, bottom: 0, left: 0 },
    };
  });
}

const auditCases = seededAuditCases(0x0f3a_2026);
const locales = ["en", "de", "es"] as const;
type Locale = (typeof locales)[number];
const longWord = "UnbrokenResponsiveRegressionWord".repeat(8);
const hostileUnicode = "超長い設定名مرحبا_שלום_👩🏽‍💻_é_".repeat(10);
const longTitle = `Responsive regression: ${hostileUnicode}${longWord}`;

function log(message: string) {
  console.log(`[responsive-regression] ${message}`);
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

async function freePort() {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert(address && typeof address !== "string", "Could not allocate a port");
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return address.port;
}

async function delay(milliseconds: number) {
  await new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function writeSse(response: ServerResponse, payload: unknown) {
  response.write(`data: ${JSON.stringify(payload)}\n\n`);
}

async function startFakeModel(port: number) {
  fakeModel = createServer((request, response) => {
    if (request.method !== "POST" || !request.url?.startsWith("/v1/chat/completions")) {
      response.writeHead(404).end();
      return;
    }
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk) => (body += chunk));
    request.on("end", () => {
      const parsed = JSON.parse(body) as { messages?: Array<{ role?: string; content?: unknown }> };
      const userContent = [...(parsed.messages ?? [])]
        .reverse()
        .find((message) => message.role === "user")?.content;
      const prompt = typeof userContent === "string" ? userContent : "";
      if (prompt.includes("RESPONSIVE_PROVIDER_ERROR")) {
        response.writeHead(500, { "content-type": "application/json" });
        response.end(
          JSON.stringify({
            error: {
              message: `Provider failed at https://models.example.test/${longWord}/${longWord}`,
            },
          }),
        );
        return;
      }
      response.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
      });
      writeSse(response, { choices: [{ delta: { content: "Responsive fixture started. " } }] });
      if (prompt.includes("RESPONSIVE_LOADING")) {
        setTimeout(() => {
          if (response.destroyed) return;
          writeSse(response, { choices: [{ delta: { content: "Loading fixture completed." } }] });
          writeSse(response, {
            choices: [{ delta: {}, finish_reason: "stop" }],
            usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 },
          });
          response.write("data: [DONE]\n\n");
          response.end();
        }, 120_000);
        return;
      }
      writeSse(response, {
        choices: [
          {
            delta: {
              content:
                `\n\n${longWord}\n\nhttps://example.test/${longWord}?next=${longWord}` +
                "\n\n| Extremely long responsive heading | Value |\n| --- | --- |\n" +
                `| ${longWord} | ${longWord} |\n\n\`\`\`text\n${longWord}\n\`\`\``,
            },
          },
        ],
      });
      writeSse(response, {
        choices: [{ delta: {}, finish_reason: "stop" }],
        usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 },
      });
      response.write("data: [DONE]\n\n");
      response.end();
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
    const output = chunk.toString();
    logs.push(output);
    if (process.env.OPENGUI_E2E_VERBOSE === "1") process.stdout.write(output);
  };
  child.stdout?.on("data", capture);
  child.stderr?.on("data", capture);
  children.push(child);
}

async function waitForUrl(url: string, timeout = 25_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    try {
      if ((await fetch(url)).ok) return;
    } catch {}
    await delay(150);
  }
  throw new Error(`Timed out waiting for ${url}\n${logs.join("").slice(-4_000)}`);
}

async function browser(session: string, ...arguments_: string[]) {
  const result = await execFileAsync("agent-browser", ["--session", session, ...arguments_], {
    cwd: root,
    maxBuffer: 8 * 1024 * 1024,
  });
  return result.stdout.trim();
}

async function find(
  session: string,
  kind: "label" | "placeholder" | "text" | "role",
  value: string,
  action: string,
  actionValue?: string,
) {
  const arguments_ = ["find", kind];
  if (kind === "role") arguments_.push(value, action, "--name", actionValue ?? "", "--exact");
  else arguments_.push(value, action, ...(actionValue === undefined ? [] : [actionValue]));
  await browser(session, ...arguments_);
}

async function clickButton(session: string, name: string) {
  await find(session, "role", "button", "click", name);
}

async function fillLabel(session: string, label: string, value: string) {
  await find(session, "label", label, "fill", value);
}

async function waitForText(session: string, text: string, timeout = 20_000) {
  await browser(session, "wait", "--text", text, "--timeout", String(timeout));
}

type ApiSession = { token: string; actor: { id: string } };

async function api<T>(
  backendUrl: string,
  path: string,
  options: { token?: string; method?: string; body?: unknown } = {},
) {
  const response = await fetch(`${backendUrl}${path}`, {
    method: options.method ?? "GET",
    headers: {
      ...(options.token ? { authorization: `Bearer ${options.token}` } : {}),
      ...(options.body === undefined ? {} : { "content-type": "application/json" }),
    },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  const envelope = (await response.json().catch(() => null)) as {
    ok?: boolean;
    value?: T;
    error?: string;
  } | null;
  if (!response.ok || !envelope?.ok) {
    throw new Error(
      `${options.method ?? "GET"} ${path}: ${response.status} ${envelope?.error ?? ""}`,
    );
  }
  return envelope.value as T;
}

async function login(backendUrl: string, username: string, password: string) {
  return await api<ApiSession>(backendUrl, "/api/identity/login", {
    method: "POST",
    body: { username, password },
  });
}

function formatFindings(
  state: string,
  locale: string,
  width: number,
  height: number,
  findings: ResponsiveAuditFinding[],
) {
  return [
    `${state} / ${locale} / ${width}x${height}: ${findings.length} responsive defect(s)`,
    ...findings.map(
      (finding) =>
        `- [${finding.rule}] ${finding.selector} text=${JSON.stringify(finding.text)} ` +
        `rect=${JSON.stringify(finding.rect)} scroll=${JSON.stringify(finding.scroll)} ` +
        `client=${JSON.stringify(finding.client)} viewport=${JSON.stringify(finding.viewport)} ` +
        finding.detail,
    ),
  ].join("\n");
}

async function auditMatrix(
  session: string,
  state: string,
  prepare?: (locale: Locale) => Promise<void>,
) {
  log(`audit ${state}`);
  await browser(session, "set", "media", "light", "reduced-motion");
  for (const locale of locales) {
    await browser(
      session,
      "eval",
      `localStorage.setItem('opengui:web:settings:opengui:language', '${locale}'); true`,
    );
    await browser(session, "reload");
    await browser(session, "wait", "--fn", `document.documentElement.lang === '${locale}'`);
    await prepare?.(locale);
    for (const auditCase of auditCases) {
      const { width, height, textScale, dpr, coarsePointer, safeArea } = auditCase;
      await browser(session, "set", "viewport", String(width), String(height), String(dpr));
      await browser(
        session,
        "eval",
        `document.documentElement.style.fontSize='${16 * textScale}px';` +
          `document.documentElement.style.setProperty('--safe-area-inset-top','${safeArea.top}px');` +
          `document.documentElement.style.setProperty('--safe-area-inset-right','${safeArea.right}px');` +
          `document.documentElement.style.setProperty('--safe-area-inset-bottom','${safeArea.bottom}px');` +
          `document.documentElement.style.setProperty('--safe-area-inset-left','${safeArea.left}px');` +
          `document.documentElement.dataset.responsiveLargeText='${textScale > 1}';` +
          `document.documentElement.dataset.responsiveCoarse='${coarsePointer}'; true`,
      );
      await delay(80);
      const result = JSON.parse(
        await browser(
          session,
          "eval",
          responsiveAuditExpression({
            coarsePointer,
            state,
            locale,
          }),
        ),
      ) as {
        findings: ResponsiveAuditFinding[];
        root: { scrollWidth: number; clientWidth: number };
      };
      if (result.root.scrollWidth > result.root.clientWidth + 1) {
        throw new Error(
          `${state} / ${locale} / ${width}x${height}: document root overflow ` +
            `${result.root.scrollWidth} > ${result.root.clientWidth}`,
        );
      }
      if (result.findings.length > 0) {
        throw new Error(formatFindings(state, locale, width, height, result.findings));
      }
      if (auditCase === auditCases[0]) {
        // Exercise keyboard-only focus movement while each state is live. The
        // geometry audit then verifies focused portals/overlays just like mouse-opened UI.
        let reachedControl = false;
        for (let step = 0; step < 6; step += 1) {
          await browser(session, "press", "Tab");
          const focused = JSON.parse(
            await browser(
              session,
              "eval",
              "(()=>{const e=document.activeElement;return {tag:e?.tagName,disabled:e?.hasAttribute('disabled')}})()",
            ),
          ) as { tag?: string; disabled?: boolean };
          if (focused.tag && focused.tag !== "BODY") {
            reachedControl = true;
            assert(
              !focused.disabled,
              `${state}/${locale}: keyboard focus entered a disabled control`,
            );
            break;
          }
        }
        assert(reachedControl, `${state}/${locale}: keyboard focus could not reach a control`);
      }
    }
  }
  await browser(session, "set", "viewport", "1200", "900", "1");
  await browser(
    session,
    "eval",
    "document.documentElement.style.fontSize='16px';document.documentElement.dataset.responsiveCoarse='false';document.documentElement.style.setProperty('--safe-area-inset-top','0px');document.documentElement.style.setProperty('--safe-area-inset-right','0px');document.documentElement.style.setProperty('--safe-area-inset-bottom','0px');document.documentElement.style.setProperty('--safe-area-inset-left','0px');true",
  );
}

async function setupOwner(frontendUrl: string, backendUrl: string) {
  const ownerBrowser = browserSessions[0]!;
  await browser(ownerBrowser, "open", frontendUrl);
  await browser(ownerBrowser, "set", "device", "iPhone 14");
  await browser(ownerBrowser, "set", "viewport", "390", "844");
  await waitForText(ownerBrowser, "Set up this Host");
  await auditMatrix(ownerBrowser, "owner-account-setup");
  await browser(
    ownerBrowser,
    "eval",
    "localStorage.setItem('opengui:web:settings:opengui:language','en');true",
  );
  await browser(ownerBrowser, "reload");
  await browser(ownerBrowser, "wait", "--fn", "document.documentElement.lang === 'en'");
  await waitForText(ownerBrowser, "Set up this Host");
  await fillLabel(ownerBrowser, "Username", "responsive_owner");
  await fillLabel(ownerBrowser, "Email", "responsive-owner@example.test");
  await fillLabel(ownerBrowser, "Password", "responsive-password");
  await fillLabel(ownerBrowser, "Confirm password", "responsive-password");
  await clickButton(ownerBrowser, "Create owner account");
  await waitForText(ownerBrowser, "Connect a model");
  await auditMatrix(ownerBrowser, "owner-setup-wizard-model");
  await browser(
    ownerBrowser,
    "eval",
    "localStorage.setItem('opengui:web:settings:opengui:language','en');true",
  );
  await browser(ownerBrowser, "reload");
  await browser(ownerBrowser, "wait", "--fn", "document.documentElement.lang === 'en'");
  await waitForText(ownerBrowser, "Connect a model");
  await clickButton(ownerBrowser, "Close");
  return await login(backendUrl, "responsive_owner", "responsive-password");
}

async function run(frontendUrl: string, backendUrl: string, modelPort: number) {
  const [ownerBrowser, memberBrowser, publicBrowser, errorBrowser] = browserSessions;
  const owner = await setupOwner(frontendUrl, backendUrl);

  await auditMatrix(ownerBrowser!, "owner-empty");

  await api(backendUrl, "/api/identity/host-policy", {
    token: owner.token,
    method: "PUT",
    body: { registrationMode: "open" },
  });
  await browser(memberBrowser!, "open", frontendUrl);
  await browser(memberBrowser!, "set", "device", "iPhone 14");
  await waitForText(memberBrowser!, "Sign in to OpenGUI");
  await find(memberBrowser!, "text", "Need an account? Register", "click");
  await waitForText(memberBrowser!, "Create an account");
  await fillLabel(memberBrowser!, "Username", "rsp_member");
  await fillLabel(memberBrowser!, "Email", "responsive-member@example.test");
  await fillLabel(memberBrowser!, "Password", "responsive-password");
  await fillLabel(memberBrowser!, "Confirm password", "responsive-password");
  await clickButton(memberBrowser!, "Create account");
  await waitForText(memberBrowser!, "Connect a model");
  await clickButton(memberBrowser!, "Close");
  const member = await login(backendUrl, "rsp_member", "responsive-password");
  await waitForText(memberBrowser!, "No project folders have been shared");
  await auditMatrix(memberBrowser!, "member-empty-share-only");

  await api(backendUrl, "/api/host/models", {
    token: owner.token,
    method: "POST",
    body: {
      id: "responsive-long-model-connection",
      label: `Model ${longWord}`,
      baseUrl: `http://127.0.0.1:${modelPort}/v1`,
      apiKey: "fixture-key",
      modelIds: [`model-${longWord}`],
      plane: "host",
    },
  });
  await api(
    backendUrl,
    "/api/identity/model-connections/responsive-long-model-connection/entitlements",
    {
      token: owner.token,
      method: "PUT",
      body: {
        entitlements: [
          { subjectType: "team", subjectId: "host_default", modelId: `model-${longWord}` },
        ],
      },
    },
  );
  await api(backendUrl, "/api/host/projects", {
    token: owner.token,
    method: "POST",
    body: { directory: projectDirectory },
  });
  const session = await api<{ id: string }>(backendUrl, "/api/host/sessions", {
    token: owner.token,
    method: "POST",
    body: {
      directory: projectDirectory,
      title: longTitle,
      model: {
        connectionId: "responsive-long-model-connection",
        modelId: `model-${longWord}`,
      },
      reasoning: "none",
    },
  });
  await api(backendUrl, `/api/host/sessions/${session.id}/prompt`, {
    token: owner.token,
    method: "POST",
    body: { text: `Long URL https://example.test/${longWord} and ${longWord}` },
  });
  await delay(500);
  await api(backendUrl, `/api/host/sessions/${session.id}/prompt`, {
    token: owner.token,
    method: "POST",
    body: { text: "RESPONSIVE_PROVIDER_ERROR" },
  });
  await delay(500);
  await browser(ownerBrowser!, "reload");
  await waitForText(ownerBrowser!, "Responsive regression:");
  await find(ownerBrowser!, "text", "Responsive regression:", "click");
  await waitForText(ownerBrowser!, "Provider failed", 20_000);
  await auditMatrix(ownerBrowser!, "owner-populated-error-long-content");

  await api(backendUrl, `/api/host/sessions/${session.id}/prompt`, {
    token: owner.token,
    method: "POST",
    body: { text: "RESPONSIVE_LOADING" },
  });
  await waitForText(ownerBrowser!, "Responsive fixture started.", 10_000);
  await auditMatrix(ownerBrowser!, "owner-loading-running");

  await browser(
    ownerBrowser!,
    "eval",
    "window.dispatchEvent(new Event('opengui:open-settings')); true",
  );
  await waitForText(ownerBrowser!, "Preferencias, modelos");
  await auditMatrix(ownerBrowser!, "owner-settings", async () => {
    await browser(
      ownerBrowser!,
      "eval",
      "window.dispatchEvent(new Event('opengui:open-settings')); true",
    );
    await browser(ownerBrowser!, "wait", "--fn", "!!document.querySelector('#settings-section')");
  });
  await auditMatrix(ownerBrowser!, "owner-settings-providers", async () => {
    await browser(
      ownerBrowser!,
      "eval",
      "window.dispatchEvent(new Event('opengui:open-settings')); true",
    );
    await browser(ownerBrowser!, "wait", "--fn", "!!document.querySelector('#settings-section')");
    await browser(
      ownerBrowser!,
      "eval",
      "const s=document.querySelector('#settings-section'); s.value='models'; s.dispatchEvent(new Event('change',{bubbles:true})); true",
    );
  });
  await auditMatrix(ownerBrowser!, "owner-settings-skills", async () => {
    await browser(
      ownerBrowser!,
      "eval",
      "window.dispatchEvent(new Event('opengui:open-settings')); true",
    );
    await browser(ownerBrowser!, "wait", "--fn", "!!document.querySelector('#settings-section')");
    await browser(
      ownerBrowser!,
      "eval",
      "const s=document.querySelector('#settings-section'); s.value='skills'; s.dispatchEvent(new Event('change',{bubbles:true})); true",
    );
    await browser(
      ownerBrowser!,
      "wait",
      "--fn",
      "!!document.querySelector('[data-testid=skills-library]')",
    );
  });
  await auditMatrix(ownerBrowser!, "owner-settings-team", async () => {
    await browser(
      ownerBrowser!,
      "eval",
      "window.dispatchEvent(new Event('opengui:open-settings')); true",
    );
    await browser(ownerBrowser!, "wait", "--fn", "!!document.querySelector('#settings-section')");
    await browser(
      ownerBrowser!,
      "eval",
      "const s=document.querySelector('#settings-section'); s.value='users'; s.dispatchEvent(new Event('change',{bubbles:true})); true",
    );
  });
  await clickButton(ownerBrowser!, "Volver");
  await waitForText(ownerBrowser!, "Responsive regression:");
  await browser(
    ownerBrowser!,
    "eval",
    `window.dispatchEvent(new CustomEvent('opengui:open-session-share', { detail: { sessionId: '${session.id}', title: ${JSON.stringify(longTitle)} } })); true`,
  );
  await waitForText(ownerBrowser!, "Compartir sesión");
  await auditMatrix(ownerBrowser!, "owner-share-dialog", async () => {
    await browser(
      ownerBrowser!,
      "eval",
      `window.dispatchEvent(new CustomEvent('opengui:open-session-share', { detail: { sessionId: '${session.id}', title: ${JSON.stringify(longTitle)} } })); true`,
    );
    await browser(
      ownerBrowser!,
      "wait",
      "--fn",
      "!!document.querySelector('[data-slot=dialog-content]')",
    );
  });
  await browser(ownerBrowser!, "press", "Escape");

  await api(backendUrl, `/api/identity/members/${member.actor.id}/path-grants`, {
    token: owner.token,
    method: "PUT",
    body: { grants: [{ root: projectDirectory, access: "read" }] },
  });
  await api(backendUrl, `/api/identity/sessions/${session.id}/shares`, {
    token: owner.token,
    method: "POST",
    body: { granteeType: "user", granteeId: member.actor.id, role: "view" },
  });
  await browser(memberBrowser!, "reload");
  await waitForText(memberBrowser!, "Responsive regression:");
  await find(memberBrowser!, "text", "Responsive regression:", "click");
  await waitForText(memberBrowser!, "Long URL");
  await auditMatrix(memberBrowser!, "member-read-only-populated");

  const link = await api<{ token: string }>(
    backendUrl,
    `/api/identity/sessions/${session.id}/view-links`,
    { token: owner.token, method: "POST" },
  );
  await browser(publicBrowser!, "open", `${frontendUrl}?view=${encodeURIComponent(link.token)}`);
  await browser(publicBrowser!, "set", "device", "iPhone 14");
  await waitForText(publicBrowser!, "Read-only transcript");
  await waitForText(publicBrowser!, "Long URL");
  await auditMatrix(publicBrowser!, "public-read-only-populated");

  await browser(errorBrowser!, "open", `${frontendUrl}?view=invalid-responsive-token`);
  await browser(errorBrowser!, "set", "device", "iPhone 14");
  await waitForText(errorBrowser!, "This view link is invalid");
  await auditMatrix(errorBrowser!, "public-error");

  for (const browserSession of browserSessions) {
    const errors = await browser(browserSession, "errors");
    if (errors && !/No page errors/iu.test(errors)) throw new Error(`${browserSession}: ${errors}`);
  }
}

async function cleanup() {
  await Promise.all(
    browserSessions.map((session) => browser(session, "close").catch(() => undefined)),
  );
  for (const child of children.reverse()) {
    if (child.exitCode === null && child.pid) await terminateDetachedProcessTree(child.pid);
  }
  await delay(250);
  for (const child of children) {
    if (child.exitCode === null && child.pid) {
      await terminateDetachedProcessTree(child.pid, { force: true });
    }
  }
  if (fakeModel) {
    fakeModel.closeAllConnections();
    await new Promise<void>((resolve) => fakeModel!.close(() => resolve()));
  }
  await rm(temporaryRoot, { recursive: true, force: true });
}

try {
  await Promise.all([mkdir(dataDirectory), mkdir(projectDirectory, { recursive: true })]);
  const [modelPort, backendPort, frontendPort] = await Promise.all([
    freePort(),
    freePort(),
    freePort(),
  ]);
  await startFakeModel(modelPort);
  startDevelopmentStack(frontendPort, backendPort);
  const frontendUrl = `http://127.0.0.1:${frontendPort}`;
  await waitForUrl(frontendUrl);
  await run(frontendUrl, `http://127.0.0.1:${backendPort}`, modelPort);
  log("PASS: all responsive states, locales, and viewports passed");
} catch (error) {
  const screenshot = join(tmpdir(), `opengui-responsive-${runId}.png`);
  await browser(browserSessions[0]!, "screenshot", screenshot, "--full").catch(() => undefined);
  console.error(`[responsive-regression] FAIL (screenshot: ${screenshot})`);
  console.error(error);
  console.error(logs.join("").slice(-6_000));
  process.exitCode = 1;
} finally {
  await cleanup();
}
