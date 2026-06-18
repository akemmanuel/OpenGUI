import type { HarnessId } from "@opengui/protocol";

export interface SessionRecord {
  id: string;
  rawId: string;
  /** Canonical filesystem directory for harness scope (not a Frontend Project id). */
  directory: string;
  harnessId: HarnessId;
  title: string;
  createdAt: string;
  updatedAt: string;
  status: "idle" | "running" | "error" | "unknown";
  metadata?: Record<string, unknown>;
}

export interface CreateSessionInput {
  id?: string;
  rawId: string;
  directory: string;
  harnessId: HarnessId;
  title?: string;
  status?: SessionRecord["status"];
  metadata?: Record<string, unknown>;
  createdAt?: string;
  updatedAt?: string;
}

export interface UpdateSessionInput {
  title?: string;
  status?: SessionRecord["status"];
  metadata?: Record<string, unknown>;
}

export interface ListSessionsInput {
  directory?: string;
  harnessId?: HarnessId;
  cursor?: string | null;
  limit?: number;
}

/** Resolved directory for harness list operations (canonical path on disk). */
export interface ResolvedHarnessDirectory {
  directory: string;
  canonicalPath: string;
}

export interface ListSessionsResult {
  sessions: SessionRecord[];
  nextCursor: string | null;
}
