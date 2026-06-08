import type { HarnessId } from "../../src/agents/index.ts";
import type { SelectedModel } from "../../src/types/electron.d.ts";
import type { BackendServiceContext, ProjectRecord, SessionRecord } from "./index.ts";
import { buildHarnessScope } from "./harness-scope.ts";
import { ensureSessionFromRuntime } from "./runtime-session-mapper.ts";

export async function createSessionThroughHarness(input: {
  services: BackendServiceContext;
  project: ProjectRecord;
  harnessId: HarnessId;
  title?: string;
}): Promise<SessionRecord> {
  const runtimeSession = await input.services.harnesses.createSession({
    scope: buildHarnessScope({ project: input.project, harnessId: input.harnessId }),
    title: input.title,
  });
  return await ensureSessionFromRuntime({
    sessions: input.services.sessions,
    runtimeSession,
    projectId: input.project.id,
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
      projectId: input.canonicalPath,
      harnessId: input.harnessId,
      directory: input.canonicalPath,
    },
    title: input.title,
  });
  return await ensureSessionFromRuntime({
    sessions: input.services.sessions,
    runtimeSession,
    projectId: input.canonicalPath,
    harnessId: input.harnessId,
  });
}

export async function renameSessionThroughHarness(input: {
  services: BackendServiceContext;
  project: ProjectRecord;
  session: SessionRecord;
  title: string;
}): Promise<SessionRecord> {
  const runtimeSession = await input.services.harnesses.updateSession({
    session: input.session,
    scope: buildHarnessScope({
      project: input.project,
      harnessId: input.session.harnessId,
      sessionId: input.session.id,
    }),
    title: input.title,
  });
  return await ensureSessionFromRuntime({
    sessions: input.services.sessions,
    runtimeSession,
    projectId: input.session.projectId,
    harnessId: input.session.harnessId,
  });
}

export async function forkSessionThroughHarness(input: {
  services: BackendServiceContext;
  project: ProjectRecord;
  session: SessionRecord;
  messageId?: string;
}): Promise<SessionRecord> {
  const runtimeSession = await input.services.harnesses.forkSession({
    session: input.session,
    scope: buildHarnessScope({
      project: input.project,
      harnessId: input.session.harnessId,
      sessionId: input.session.id,
    }),
    messageId: input.messageId,
  });
  return await ensureSessionFromRuntime({
    sessions: input.services.sessions,
    runtimeSession,
    projectId: input.session.projectId,
    harnessId: input.session.harnessId,
  });
}

export async function revertSessionThroughHarness(input: {
  services: BackendServiceContext;
  session: SessionRecord;
  messageId: string;
  partId?: string;
}): Promise<SessionRecord | null> {
  const runtimeSession = await input.services.harnesses.revertSession({
    session: input.session,
    messageId: input.messageId,
    partId: input.partId,
  });
  if (!runtimeSession || typeof runtimeSession !== "object" || Array.isArray(runtimeSession)) {
    return null;
  }
  return await ensureSessionFromRuntime({
    sessions: input.services.sessions,
    runtimeSession,
    projectId: input.session.projectId,
    harnessId: input.session.harnessId,
  });
}

export async function unrevertSessionThroughHarness(input: {
  services: BackendServiceContext;
  session: SessionRecord;
}): Promise<SessionRecord | null> {
  const runtimeSession = await input.services.harnesses.unrevertSession({ session: input.session });
  if (!runtimeSession || typeof runtimeSession !== "object" || Array.isArray(runtimeSession)) {
    return null;
  }
  return await ensureSessionFromRuntime({
    sessions: input.services.sessions,
    runtimeSession,
    projectId: input.session.projectId,
    harnessId: input.session.harnessId,
  });
}

export async function listSessionMessagesThroughHarness(input: {
  services: BackendServiceContext;
  project: ProjectRecord;
  session: SessionRecord;
  options: { limit?: number; before?: string | null };
}): Promise<unknown> {
  return await input.services.harnesses.listMessages({
    session: input.session,
    scope: buildHarnessScope({
      project: input.project,
      harnessId: input.session.harnessId,
      sessionId: input.session.id,
    }),
    options: input.options,
  });
}

export async function promptSessionThroughHarness(input: {
  services: BackendServiceContext;
  project: ProjectRecord;
  session: SessionRecord;
  text: string;
  model?: SelectedModel;
  agent?: string;
  variant?: string;
}): Promise<void> {
  await input.services.harnesses.promptSession({
    session: input.session,
    scope: buildHarnessScope({
      project: input.project,
      harnessId: input.session.harnessId,
      sessionId: input.session.id,
    }),
    text: input.text,
    model: input.model,
    agent: input.agent,
    variant: input.variant,
  });
}

export async function sendCommandThroughHarness(input: {
  services: BackendServiceContext;
  project: ProjectRecord;
  session: SessionRecord;
  command: string;
  args: string;
  model?: SelectedModel;
  agent?: string;
  variant?: string;
}): Promise<void> {
  await input.services.harnesses.sendCommand({
    session: input.session,
    scope: buildHarnessScope({
      project: input.project,
      harnessId: input.session.harnessId,
      sessionId: input.session.id,
    }),
    command: input.command,
    args: input.args,
    model: input.model,
    agent: input.agent,
    variant: input.variant,
  });
}

export async function compactSessionThroughHarness(input: {
  services: BackendServiceContext;
  project: ProjectRecord;
  session: SessionRecord;
  model?: SelectedModel;
}): Promise<void> {
  await input.services.harnesses.compactSession({
    session: input.session,
    scope: buildHarnessScope({
      project: input.project,
      harnessId: input.session.harnessId,
      sessionId: input.session.id,
    }),
    model: input.model,
  });
}

export async function deleteSessionThroughHarness(input: {
  services: BackendServiceContext;
  project: ProjectRecord;
  session: SessionRecord;
}): Promise<void> {
  await input.services.harnesses.deleteSession({
    session: input.session,
    scope: buildHarnessScope({
      project: input.project,
      harnessId: input.session.harnessId,
      sessionId: input.session.id,
    }),
  });
  await input.services.sessions.deleteSession(input.session.id);
}

export async function abortSessionThroughHarness(input: {
  services: BackendServiceContext;
  project: ProjectRecord;
  session: SessionRecord;
}): Promise<void> {
  await input.services.harnesses.abortSession({
    session: input.session,
    scope: buildHarnessScope({
      project: input.project,
      harnessId: input.session.harnessId,
      sessionId: input.session.id,
    }),
  });
}
