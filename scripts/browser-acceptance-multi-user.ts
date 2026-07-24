import { execFile, spawn, type ChildProcess } from "node:child_process";
import { createServer, type Server, type ServerResponse } from "node:http";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { terminateDetachedProcessTree } from "./process-tree.ts";

const execFileAsync = promisify(execFile);
const root = process.cwd();
const runId = `${process.pid}-${Date.now()}`;
const temporaryRoot = await mkdtemp(join(tmpdir(), "opengui-multi-user-acceptance-"));
const dataDirectory = join(temporaryRoot, "host-data");
const projectDirectory = join(temporaryRoot, "project");
const writableDirectory = join(projectDirectory, "writable");
const logs: string[] = [];
const children: ChildProcess[] = [];
const browserSessions = ["owner", "invited", "registered", "public", "invalid"].map(
  (name) => `opengui-multi-user-${name}-${runId}`,
);
let fakeModel: Server | undefined;

function log(message: string) {
  console.log(`[multi-user-acceptance] ${message}`);
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
      const content = [...(parsed.messages ?? [])]
        .reverse()
        .find((message) => message.role === "user")?.content;
      response.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
      });
      writeSse(response, {
        choices: [
          { delta: { content: `Shared echo: ${typeof content === "string" ? content : ""}` } },
        ],
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
    const text = chunk.toString();
    logs.push(text);
    if (process.env.OPENGUI_E2E_VERBOSE === "1") process.stdout.write(text);
  };
  child.stdout?.on("data", capture);
  child.stderr?.on("data", capture);
  children.push(child);
}

async function waitForUrl(url: string, timeoutMilliseconds = 25_000) {
  const deadline = Date.now() + timeoutMilliseconds;
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
    maxBuffer: 4 * 1024 * 1024,
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

async function pageText(session: string) {
  return await browser(session, "get", "text", "body");
}

async function expectText(session: string, text: string) {
  assert((await pageText(session)).includes(text), `Expected ${session} page to contain ${text}`);
}

async function expectNoText(session: string, text: string) {
  assert(
    !(await pageText(session)).includes(text),
    `Expected ${session} page not to contain ${text}`,
  );
}

type ApiSession = { token: string; actor: { id: string; displayName: string; role: string } };

async function apiResponse(
  backendUrl: string,
  path: string,
  options: { token?: string; method?: string; body?: unknown; form?: FormData } = {},
) {
  const headers = new Headers();
  if (options.token) headers.set("authorization", `Bearer ${options.token}`);
  if (options.body !== undefined) headers.set("content-type", "application/json");
  return await fetch(`${backendUrl}${path}`, {
    method: options.method ?? "GET",
    headers,
    body: options.form ?? (options.body === undefined ? undefined : JSON.stringify(options.body)),
  });
}

async function api<T>(
  backendUrl: string,
  path: string,
  options: { token?: string; method?: string; body?: unknown; form?: FormData } = {},
) {
  const response = await apiResponse(backendUrl, path, options);
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

async function closeSetupWizard(session: string) {
  await waitForText(session, "Connect a model");
  await clickButton(session, "Close");
}

async function runScenarios(frontendUrl: string, backendUrl: string, modelPort: number) {
  const [ownerBrowser, invitedBrowser, registeredBrowser, publicBrowser, invalidBrowser] =
    browserSessions;

  log("owner bootstrap uses the product setup gate on a fresh isolated Host");
  await browser(ownerBrowser!, "open", frontendUrl);
  await browser(ownerBrowser!, "set", "viewport", "1440", "900");
  await waitForText(ownerBrowser!, "Set up this Host");
  await fillLabel(ownerBrowser!, "Username", "acceptance_owner");
  await fillLabel(ownerBrowser!, "Email", "owner@example.test");
  await fillLabel(ownerBrowser!, "Password", "acceptance-password");
  await fillLabel(ownerBrowser!, "Confirm password", "acceptance-password");
  await clickButton(ownerBrowser!, "Create owner account");
  await closeSetupWizard(ownerBrowser!);
  const owner = await login(backendUrl, "acceptance_owner", "acceptance-password");

  log("logout invalidates the old session and username/password login restores the account");
  await clickButton(ownerBrowser!, "Settings");
  await waitForText(ownerBrowser!, "Host account");
  await clickButton(ownerBrowser!, "Sign out");
  await waitForText(ownerBrowser!, "Sign in to OpenGUI");
  await fillLabel(ownerBrowser!, "Username", "acceptance_owner");
  await fillLabel(ownerBrowser!, "Password", "acceptance-password");
  await clickButton(ownerBrowser!, "Sign in");
  await waitForText(ownerBrowser!, "Settings");
  await clickButton(ownerBrowser!, "Settings");
  await waitForText(ownerBrowser!, "Manage app preferences and providers for active workspace.");

  log("invite-only registration is closed and the owner-only Team surface is visible");
  const closedRegistration = await apiResponse(backendUrl, "/api/identity/register", {
    method: "POST",
    body: {
      username: "closed_user",
      email: "closed@example.test",
      password: "acceptance-password",
    },
  });
  assert(closedRegistration.status === 403, "Invite-only Host accepted open registration");
  await find(ownerBrowser!, "role", "tab", "click", "Team");
  await waitForText(ownerBrowser!, "Members");
  await expectText(ownerBrowser!, "Invite only");

  log("an invite with initial read access is accepted in a second isolated browser");
  const invite = await api<{ token: string }>(backendUrl, "/api/identity/invites", {
    token: owner.token,
    method: "POST",
    body: {
      email: "invited@example.test",
      pathGrants: [{ root: projectDirectory, access: "read" }],
    },
  });
  await browser(
    invitedBrowser!,
    "open",
    `${frontendUrl}?invite=${encodeURIComponent(invite.token)}`,
  );
  await waitForText(invitedBrowser!, "Join this Team");
  await fillLabel(invitedBrowser!, "Username", "invited_member");
  await fillLabel(invitedBrowser!, "Email", "invited@example.test");
  await fillLabel(invitedBrowser!, "Password", "acceptance-password");
  await fillLabel(invitedBrowser!, "Confirm password", "acceptance-password");
  await clickButton(invitedBrowser!, "Join Team");
  await closeSetupWizard(invitedBrowser!);
  const invited = await login(backendUrl, "invited_member", "acceptance-password");

  log(
    "canInvite is explicit; members without it are forbidden and delegated grants cannot escalate",
  );
  const forbiddenInvite = await apiResponse(backendUrl, "/api/identity/invites", {
    token: invited.token,
    method: "POST",
    body: { email: "forbidden@example.test" },
  });
  assert(forbiddenInvite.status === 403, "Member invited without canInvite");
  await api(backendUrl, `/api/identity/members/${invited.actor.id}/can-invite`, {
    token: owner.token,
    method: "PUT",
    body: { canInvite: true },
  });
  await api(backendUrl, "/api/identity/invites", {
    token: invited.token,
    method: "POST",
    body: {
      email: "delegated@example.test",
      pathGrants: [{ root: projectDirectory, access: "read" }],
    },
  });
  const escalatedInvite = await apiResponse(backendUrl, "/api/identity/invites", {
    token: invited.token,
    method: "POST",
    body: {
      email: "escalated@example.test",
      pathGrants: [{ root: projectDirectory, access: "write" }],
    },
  });
  assert(escalatedInvite.status === 403, "Read-only inviter delegated write access");

  log("open registration creates a grant-less third account through the product UI");
  await api(backendUrl, "/api/identity/host-policy", {
    token: owner.token,
    method: "PUT",
    body: { registrationMode: "open" },
  });
  await browser(registeredBrowser!, "open", frontendUrl);
  await waitForText(registeredBrowser!, "Sign in to OpenGUI");
  await find(registeredBrowser!, "text", "Need an account? Register", "click");
  await waitForText(registeredBrowser!, "Create an account");
  await fillLabel(registeredBrowser!, "Username", "open_member");
  await fillLabel(registeredBrowser!, "Email", "open@example.test");
  await fillLabel(registeredBrowser!, "Password", "acceptance-password");
  await fillLabel(registeredBrowser!, "Confirm password", "acceptance-password");
  await clickButton(registeredBrowser!, "Create account");
  await closeSetupWizard(registeredBrowser!);
  const registered = await login(backendUrl, "open_member", "acceptance-password");
  await expectText(registeredBrowser!, "No project folders have been shared with your account yet");

  log("read and write grants differ at the real file/upload boundary");
  const readable = await apiResponse(
    backendUrl,
    `/api/fs/file?path=${encodeURIComponent(join(projectDirectory, "read-only.txt"))}`,
    { token: invited.token },
  );
  assert(
    readable.status === 200 && (await readable.text()) === "owner fixture",
    "Read grant failed",
  );
  const deniedUpload = new FormData();
  deniedUpload.append("directory", projectDirectory);
  deniedUpload.append("files", new File(["denied"], "denied.txt"));
  assert(
    (
      await apiResponse(backendUrl, "/api/fs/upload", {
        token: invited.token,
        method: "POST",
        form: deniedUpload,
      })
    ).status === 403,
    "Read grant permitted a write",
  );
  await api(backendUrl, `/api/identity/members/${invited.actor.id}/path-grants`, {
    token: owner.token,
    method: "PUT",
    body: {
      grants: [
        { root: projectDirectory, access: "read" },
        { root: writableDirectory, access: "write" },
      ],
    },
  });
  const allowedUpload = new FormData();
  allowedUpload.append("directory", writableDirectory);
  allowedUpload.append("files", new File(["allowed"], "allowed.txt"));
  assert(
    (
      await apiResponse(backendUrl, "/api/fs/upload", {
        token: invited.token,
        method: "POST",
        form: allowedUpload,
      })
    ).status === 200,
    "Write grant did not permit upload",
  );

  log("Host models require entitlement while personal models remain visible only to their owner");
  await api(backendUrl, "/api/host/models", {
    token: owner.token,
    method: "POST",
    body: {
      id: "shared-fixture",
      label: "Shared fixture",
      baseUrl: `http://127.0.0.1:${modelPort}/v1`,
      apiKey: "local-fixture-key",
      modelIds: ["fixture-model"],
      plane: "host",
    },
  });
  const hiddenModels = await api<Array<{ id: string }>>(backendUrl, "/api/host/models", {
    token: invited.token,
  });
  assert(
    !hiddenModels.some((model) => model.id === "shared-fixture"),
    "Host model leaked without entitlement",
  );
  await api(backendUrl, "/api/identity/model-connections/shared-fixture/entitlements", {
    token: owner.token,
    method: "PUT",
    body: {
      entitlements: [{ subjectType: "team", subjectId: "host_default", modelId: "fixture-model" }],
    },
  });
  await api(backendUrl, "/api/host/models", {
    token: invited.token,
    method: "POST",
    body: {
      id: "invited-personal",
      label: "Invited personal",
      baseUrl: `http://127.0.0.1:${modelPort}/v1`,
      apiKey: "local-personal-key",
      modelIds: ["personal-model"],
      plane: "user",
    },
  });
  const invitedModels = await api<Array<{ id: string }>>(backendUrl, "/api/host/models", {
    token: invited.token,
  });
  const ownerModels = await api<Array<{ id: string }>>(backendUrl, "/api/host/models", {
    token: owner.token,
  });
  assert(
    invitedModels.some((model) => model.id === "shared-fixture"),
    "Entitled Host model hidden",
  );
  assert(
    invitedModels.some((model) => model.id === "invited-personal"),
    "Personal model hidden from owner",
  );
  assert(
    !ownerModels.some((model) => model.id === "invited-personal"),
    "Personal model leaked to Host owner",
  );

  log("Sessions are private until explicit view/run/admin sharing is applied");
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
      title: "Remote sharing acceptance",
      model: { connectionId: "shared-fixture", modelId: "fixture-model" },
      reasoning: "none",
    },
  });
  await api(backendUrl, `/api/host/sessions/${session.id}/prompt`, {
    token: owner.token,
    method: "POST",
    body: { text: "owner private message" },
  });
  await delay(300);
  for (const account of [invited, registered]) {
    assert(
      (await apiResponse(backendUrl, `/api/host/sessions/${session.id}`, { token: account.token }))
        .status === 404,
      "Private Session leaked to another user",
    );
  }

  await api(backendUrl, `/api/identity/members/${registered.actor.id}/path-grants`, {
    token: owner.token,
    method: "PUT",
    body: { grants: [{ root: projectDirectory, access: "read" }] },
  });
  await api(backendUrl, `/api/identity/sessions/${session.id}/shares`, {
    token: owner.token,
    method: "POST",
    body: { granteeType: "user", granteeId: registered.actor.id, role: "view" },
  });
  await browser(registeredBrowser!, "reload");
  await waitForText(registeredBrowser!, "Remote sharing acceptance");
  await find(registeredBrowser!, "text", "Remote sharing acceptance", "click");
  await waitForText(registeredBrowser!, "owner private message");
  const promptDisabled = await browser(
    registeredBrowser!,
    "eval",
    "document.querySelector('[data-slot=prompt-box-textarea]')?.disabled === true",
  );
  assert(promptDisabled === "true", "View-only Session exposed an enabled PromptBox");
  assert(
    (
      await apiResponse(backendUrl, `/api/host/sessions/${session.id}/prompt`, {
        token: registered.token,
        method: "POST",
        body: { text: "must not run" },
      })
    ).status === 404,
    "View share ran a prompt",
  );

  log("admin shares can manage sharing but cannot run; revocation takes effect immediately");
  await api(backendUrl, `/api/identity/sessions/${session.id}/shares`, {
    token: owner.token,
    method: "POST",
    body: { granteeType: "user", granteeId: registered.actor.id, role: "admin" },
  });
  await api(backendUrl, `/api/identity/sessions/${session.id}/view-links`, {
    token: registered.token,
    method: "POST",
  });
  assert(
    (
      await apiResponse(backendUrl, `/api/host/sessions/${session.id}/prompt`, {
        token: registered.token,
        method: "POST",
        body: { text: "admin is still read-only" },
      })
    ).status === 404,
    "Admin share ran a prompt",
  );

  log("two browsers observe and control one Team-run Session through Host-authoritative events");
  await api(backendUrl, `/api/identity/sessions/${session.id}/shares`, {
    token: owner.token,
    method: "POST",
    body: { granteeType: "team", granteeId: "host_default", role: "run" },
  });
  await browser(ownerBrowser!, "reload");
  await waitForText(ownerBrowser!, "Remote sharing acceptance");
  await find(ownerBrowser!, "text", "Remote sharing acceptance", "click");
  await browser(invitedBrowser!, "reload");
  await waitForText(invitedBrowser!, "Remote sharing acceptance");
  await find(invitedBrowser!, "text", "Remote sharing acceptance", "click");
  await find(invitedBrowser!, "placeholder", "Message...", "fill", "member live control");
  await clickButton(invitedBrowser!, "Send message");
  await waitForText(ownerBrowser!, "Shared echo: member live control");
  await browser(
    ownerBrowser!,
    "wait",
    "--fn",
    "document.querySelector('[data-slot=prompt-box-textarea]')?.placeholder === 'Message...'",
  );
  await find(ownerBrowser!, "placeholder", "Message...", "fill", "owner live observation");
  await clickButton(ownerBrowser!, "Send message");
  await waitForText(invitedBrowser!, "Shared echo: owner live observation");

  log(
    "public links render a read-only transcript and invalid, expired, and revoked links fail closed",
  );
  const publicLink = await api<{ id: string; token: string }>(
    backendUrl,
    `/api/identity/sessions/${session.id}/view-links`,
    { token: owner.token, method: "POST" },
  );
  await browser(
    publicBrowser!,
    "open",
    `${frontendUrl}?view=${encodeURIComponent(publicLink.token)}`,
  );
  await waitForText(publicBrowser!, "Read-only transcript");
  await waitForText(publicBrowser!, "owner private message");
  await expectNoText(publicBrowser!, "Message...");
  await api(backendUrl, `/api/identity/session-view-links/${publicLink.id}`, {
    token: owner.token,
    method: "DELETE",
  });
  await browser(publicBrowser!, "reload");
  await waitForText(publicBrowser!, "This view link is invalid, expired, or has been revoked.");
  await browser(invalidBrowser!, "open", `${frontendUrl}?view=invalid-local-fixture`);
  await waitForText(invalidBrowser!, "This view link is invalid, expired, or has been revoked.");
  const expiring = await api<{ token: string }>(
    backendUrl,
    `/api/identity/sessions/${session.id}/view-links`,
    { token: owner.token, method: "POST", body: { expiresAt: Date.now() + 300 } },
  );
  await delay(400);
  assert(
    (
      await apiResponse(
        backendUrl,
        `/api/identity/session-view-links/resolve?token=${encodeURIComponent(expiring.token)}`,
      )
    ).status === 410,
    "Expired public link resolved",
  );

  await api(backendUrl, `/api/identity/sessions/${session.id}/shares/team/host_default`, {
    token: owner.token,
    method: "DELETE",
  });
  await browser(invitedBrowser!, "reload");
  await expectNoText(invitedBrowser!, "Remote sharing acceptance");

  log("UI boundary: members cannot see owner Team controls; canInvite remains API-only today");
  await clickButton(invitedBrowser!, "Settings");
  await expectNoText(invitedBrowser!, "Team");
  await expectText(invitedBrowser!, "Providers");

  for (const sessionName of browserSessions) {
    const errors = await browser(sessionName, "errors");
    if (errors && !/No page errors/i.test(errors))
      throw new Error(`${sessionName} errors:\n${errors}`);
  }
}

async function cleanup() {
  await Promise.all(
    browserSessions.map((session) => browser(session, "close").catch(() => undefined)),
  );
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
  await Promise.all([mkdir(dataDirectory), mkdir(writableDirectory, { recursive: true })]);
  await writeFile(join(projectDirectory, "read-only.txt"), "owner fixture");
  const [modelPort, backendPort, frontendPort] = await Promise.all([
    freePort(),
    freePort(),
    freePort(),
  ]);
  await startFakeModel(modelPort);
  startDevelopmentStack(frontendPort, backendPort);
  const frontendUrl = `http://127.0.0.1:${frontendPort}`;
  await waitForUrl(frontendUrl);
  await runScenarios(frontendUrl, `http://127.0.0.1:${backendPort}`, modelPort);
  log("PASS: deterministic remote multi-user identity and sharing acceptance completed");
} catch (error) {
  const screenshot = join(tmpdir(), `opengui-multi-user-acceptance-${runId}.png`);
  await browser(browserSessions[0]!, "screenshot", screenshot, "--full").catch(() => undefined);
  console.error(`[multi-user-acceptance] FAIL (owner screenshot: ${screenshot})`);
  console.error(error);
  console.error(logs.join("").slice(-6_000));
  process.exitCode = 1;
} finally {
  await cleanup();
}
