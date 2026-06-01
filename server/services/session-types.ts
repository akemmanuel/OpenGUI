import type { HarnessId } from "../../src/agents/index.ts";

export interface SessionRecord {
  id: string;
  rawId: string;
  projectId: string;
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
  projectId: string;
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
  projectId?: string;
  harnessId?: HarnessId;
  cursor?: string | null;
  limit?: number;
}

export interface ListSessionsResult {
  sessions: SessionRecord[];
  nextCursor: string | null;
}
