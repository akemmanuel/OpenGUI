import type { HarnessId, SelectedModel } from "@opengui/protocol";
/**
 * Harness-backed session mutations (create, fork, rename, …). Each success path calls
 * `ensureSessionFromRuntime` → `SessionDispatchIndex.ensureSession` to warm the dispatch index
 * for queue dispatch, SSE side effects, and mutation resolve — never for list/message reads
 * (ADR 0004, ADR 0006). See `session-resolve.ts` for read vs mutation resolve.
 */
import type { DirectoryScopeRef } from "@opengui/runtime";
import type { BackendServiceContext, SessionRecord } from "./index.ts";
import { buildHarnessScope } from "./harness-scope.ts";
import { ensureSessionFromRuntime } from "./runtime-session-mapper.ts";

export async function createSessionThroughHarness(input: {
  services: BackendServiceContext;
  scopeRef: DirectoryScopeRef;
  harnessId: HarnessId;
  title?: string;
}): Promise<SessionRecord> {
  const runtimeSession = await input.services.harnesses.createSession({
    scope: buildHarnessScope({ scopeRef: input.scopeRef, harnessId: input.harnessId }),
    title: input.title,
  });
  return await ensureSessionFromRuntime({
    sessions: input.services.sessions,
    runtimeSession,
    directory: input.scopeRef.id,
    harnessId: input.harnessId,
  });
}

export async function createDirectorySessionThroughHarness(input: {
  services: BackendServiceContext;
  directory: string;
  canonicalPath: string;
  harnessId: HarnessId;
  title?: string;
}): Promise<SessionRecord> {
  const runtimeSession = await input.services.harnesses.createSession({
    scope: {
      harnessId: input.harnessId,
      directory: input.canonicalPath,
    },
    title: input.title,
  });
  return await ensureSessionFromRuntime({
    sessions: input.services.sessions,
    runtimeSession,
    directory: input.canonicalPath,
    harnessId: input.harnessId,
  });
}

function scopeForSession(scopeRef: DirectoryScopeRef, session: SessionRecord) {
  return buildHarnessScope({
    scopeRef,
    harnessId: session.harnessId,
    sessionId: session.id,
  });
}

export async function renameSessionThroughHarness(input: {
  services: BackendServiceContext;
  scopeRef: DirectoryScopeRef;
  session: SessionRecord;
  title: string;
}): Promise<SessionRecord> {
  const runtimeSession = await input.services.harnesses.updateSession({
    session: input.session,
    scope: scopeForSession(input.scopeRef, input.session),
    title: input.title,
  });
  return await ensureSessionFromRuntime({
    sessions: input.services.sessions,
    runtimeSession,
    directory: input.session.directory,
    harnessId: input.session.harnessId,
  });
}

export async function forkSessionThroughHarness(input: {
  services: BackendServiceContext;
  scopeRef: DirectoryScopeRef;
  session: SessionRecord;
  messageId?: string;
}): Promise<SessionRecord> {
  const runtimeSession = await input.services.harnesses.forkSession({
    session: input.session,
    scope: scopeForSession(input.scopeRef, input.session),
    messageId: input.messageId,
  });
  return await ensureSessionFromRuntime({
    sessions: input.services.sessions,
    runtimeSession,
    directory: input.session.directory,
    harnessId: input.session.harnessId,
  });
}

export async function revertSessionThroughHarness(input: {
  services: BackendServiceContext;
  scopeRef: DirectoryScopeRef;
  session: SessionRecord;
  messageId: string;
  partId?: string;
}): Promise<SessionRecord | null> {
  const runtimeSession = await input.services.harnesses.revertSession({
    session: input.session,
    scope: scopeForSession(input.scopeRef, input.session),
    messageId: input.messageId,
    partId: input.partId,
  });
  if (!runtimeSession || typeof runtimeSession !== "object" || Array.isArray(runtimeSession)) {
    return null;
  }
  return await ensureSessionFromRuntime({
    sessions: input.services.sessions,
    runtimeSession,
    directory: input.session.directory,
    harnessId: input.session.harnessId,
  });
}

export async function unrevertSessionThroughHarness(input: {
  services: BackendServiceContext;
  scopeRef: DirectoryScopeRef;
  session: SessionRecord;
}): Promise<SessionRecord | null> {
  const runtimeSession = await input.services.harnesses.unrevertSession({
    session: input.session,
    scope: scopeForSession(input.scopeRef, input.session),
  });
  if (!runtimeSession || typeof runtimeSession !== "object" || Array.isArray(runtimeSession)) {
    return null;
  }
  return await ensureSessionFromRuntime({
    sessions: input.services.sessions,
    runtimeSession,
    directory: input.session.directory,
    harnessId: input.session.harnessId,
  });
}

export async function listSessionMessagesThroughHarness(input: {
  services: BackendServiceContext;
  scopeRef: DirectoryScopeRef;
  session: SessionRecord;
  options: { limit?: number; before?: string | null };
}): Promise<unknown> {
  return await input.services.harnesses.listMessages({
    session: input.session,
    scope: scopeForSession(input.scopeRef, input.session),
    options: input.options,
  });
}

export async function promptSessionThroughHarness(input: {
  services: BackendServiceContext;
  scopeRef: DirectoryScopeRef;
  session: SessionRecord;
  text: string;
  model?: SelectedModel;
  agent?: string;
  variant?: string;
}): Promise<void> {
  await input.services.harnesses.promptSession({
    session: input.session,
    scope: scopeForSession(input.scopeRef, input.session),
    text: input.text,
    model: input.model,
    agent: input.agent,
    variant: input.variant,
  });
}

export async function sendCommandThroughHarness(input: {
  services: BackendServiceContext;
  scopeRef: DirectoryScopeRef;
  session: SessionRecord;
  command: string;
  args: string;
  model?: SelectedModel;
  agent?: string;
  variant?: string;
}): Promise<void> {
  await input.services.harnesses.sendCommand({
    session: input.session,
    scope: scopeForSession(input.scopeRef, input.session),
    command: input.command,
    args: input.args,
    model: input.model,
    agent: input.agent,
    variant: input.variant,
  });
}

export async function compactSessionThroughHarness(input: {
  services: BackendServiceContext;
  scopeRef: DirectoryScopeRef;
  session: SessionRecord;
  model?: SelectedModel;
}): Promise<void> {
  await input.services.harnesses.compactSession({
    session: input.session,
    scope: scopeForSession(input.scopeRef, input.session),
    model: input.model,
  });
}

export async function deleteSessionThroughHarness(input: {
  services: BackendServiceContext;
  scopeRef: DirectoryScopeRef;
  session: SessionRecord;
}): Promise<void> {
  await input.services.harnesses.deleteSession({
    session: input.session,
    scope: scopeForSession(input.scopeRef, input.session),
  });
  await input.services.sessions.deleteSession(input.session.id);
}

export async function abortSessionThroughHarness(input: {
  services: BackendServiceContext;
  scopeRef: DirectoryScopeRef;
  session: SessionRecord;
}): Promise<void> {
  await input.services.harnesses.abortSession({
    session: input.session,
    scope: scopeForSession(input.scopeRef, input.session),
  });
}
