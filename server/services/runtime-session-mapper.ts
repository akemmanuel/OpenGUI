import type { HarnessId } from "../../src/agents/index.ts";
import { rawSessionIdForHarness } from "../../src/lib/session-identity.ts";
import { cleanSessionTitle } from "../../src/lib/session-title.ts";
import type { SessionService } from "./session-service.ts";
import type { CreateSessionInput, SessionRecord } from "./session-types.ts";

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

export function asSessionStatus(value: unknown): SessionRecord["status"] | undefined {
  return value === "idle" || value === "running" || value === "error" || value === "unknown"
    ? value
    : undefined;
}

function numberFromTimestamp(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const ms = Date.parse(value);
    return Number.isFinite(ms) ? ms : null;
  }
  if (value instanceof Date) return value.getTime();
  return null;
}

function extractRuntimeSessionTitle(session: unknown): string {
  if (!isPlainObject(session)) return "Untitled";
  const candidates = [session.title, session.name, session.slug, session.id];
  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.trim()) return cleanSessionTitle(candidate);
  }
  return "Untitled";
}

function extractRuntimeSessionTimestamps(session: unknown) {
  const record = isPlainObject(session) ? session : {};
  const time = isPlainObject(record.time) ? record.time : {};
  const createdMs =
    numberFromTimestamp(time.created) ??
    numberFromTimestamp(record.createdAt) ??
    numberFromTimestamp(record.created) ??
    Date.now();
  const updatedMs =
    numberFromTimestamp(time.updated) ??
    numberFromTimestamp(record.updatedAt) ??
    numberFromTimestamp(record.modified) ??
    createdMs;
  return {
    createdAt: new Date(createdMs).toISOString(),
    updatedAt: new Date(updatedMs).toISOString(),
  };
}

function extractRuntimeSessionMetadata(session: unknown): Record<string, unknown> | undefined {
  if (!isPlainObject(session)) return undefined;
  const metadata: Record<string, unknown> = {};
  for (const key of ["model", "version", "parentID", "projectID", "directory"]) {
    if (key in session) metadata[key] = session[key];
  }
  return Object.keys(metadata).length > 0 ? metadata : undefined;
}

export function toSessionRecordInputFromRuntime(
  session: unknown,
  scope: {
    projectId: string;
    harnessId: HarnessId;
  },
): CreateSessionInput {
  const runtimeSession = isPlainObject(session) ? session : {};
  const rawIdValue = runtimeSession._rawId ?? runtimeSession.id ?? runtimeSession.slug;
  const rawId =
    typeof rawIdValue === "string" ? rawSessionIdForHarness(rawIdValue, scope.harnessId) : "";
  if (!rawId) throw new Error("Runtime session is missing id");
  const timestamps = extractRuntimeSessionTimestamps(session);
  return {
    rawId,
    projectId: scope.projectId,
    harnessId: scope.harnessId,
    title: extractRuntimeSessionTitle(session),
    status:
      asSessionStatus(
        isPlainObject(runtimeSession.status) ? runtimeSession.status.type : runtimeSession.status,
      ) ?? "unknown",
    metadata: extractRuntimeSessionMetadata(session),
    ...timestamps,
  };
}

export async function ensureSessionFromRuntime(input: {
  sessions: SessionService;
  runtimeSession: unknown;
  projectId: string;
  harnessId: HarnessId;
}): Promise<SessionRecord> {
  return await input.sessions.ensureSession(
    toSessionRecordInputFromRuntime(input.runtimeSession, {
      projectId: input.projectId,
      harnessId: input.harnessId,
    }),
  );
}
