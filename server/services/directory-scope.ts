import type { HarnessId } from "@opengui/protocol";
import { directoryRef, type DirectoryScopeRef } from "@opengui/runtime";
import type { SessionRecord } from "./session-types.ts";

function sessionMetadataDirectory(session: SessionRecord): string | undefined {
  const value =
    session.metadata && typeof session.metadata.directory === "string"
      ? session.metadata.directory.trim()
      : "";
  return value || undefined;
}

function looksLikeFilesystemScopeKey(key: string): boolean {
  return key.startsWith("/") || key.startsWith("~");
}

/**
 * Canonical filesystem directory for harness execution and session index scope.
 * Does not touch SQLite project rows.
 */
export function sessionDirectoryHint(session: SessionRecord): string | undefined {
  const fromMeta = sessionMetadataDirectory(session);
  if (fromMeta) return fromMeta;
  return looksLikeFilesystemScopeKey(session.directory) ? session.directory : undefined;
}

export async function resolveSessionCanonicalDirectory(input: {
  session: SessionRecord;
  resolveSafeDirectory: (path: string) => Promise<string>;
}): Promise<string> {
  const hint = sessionDirectoryHint(input.session);
  if (!hint) {
    throw new Error("Session directory not found");
  }
  return await input.resolveSafeDirectory(hint);
}

/** Session index + queue scope key (canonical path). */
export function directoryScopeKeyFromSession(
  _session: SessionRecord,
  canonicalDirectory: string,
): string {
  return canonicalDirectory;
}

export async function resolveSessionDirectoryScope(input: {
  session: SessionRecord;
  resolveSafeDirectory: (path: string) => Promise<string>;
}): Promise<DirectoryScopeRef> {
  const canonicalDirectory = await resolveSessionCanonicalDirectory(input);
  return directoryRef(canonicalDirectory);
}

/** Resolves harness execution scope for a session index record (directory-first). */
export async function resolveSessionDirectoryScopeRecord(input: {
  /** Reserved for future backend lookups; scope is directory-first today. */
  services: unknown;
  session: SessionRecord;
  resolveSafeDirectory: (path: string) => Promise<string>;
}): Promise<DirectoryScopeRef> {
  void input.services;
  return await resolveSessionDirectoryScope({
    session: input.session,
    resolveSafeDirectory: input.resolveSafeDirectory,
  });
}

export function harnessScopeForDirectory(input: {
  canonicalDirectory: string;
  harnessId: HarnessId;
  sessionId?: string;
}) {
  return {
    sessionId: input.sessionId,
    harnessId: input.harnessId,
    directory: input.canonicalDirectory,
  };
}

export function queueScopeForSession(session: SessionRecord, canonicalDirectory: string) {
  return {
    directory: directoryScopeKeyFromSession(session, canonicalDirectory),
    harnessId: session.harnessId,
  };
}
