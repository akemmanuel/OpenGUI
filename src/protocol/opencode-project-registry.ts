import { normalize } from "node:path";

export interface OpencodeProjectTarget {
  directory?: string | null;
  workspaceId?: string | null;
}

export interface OpencodeProjectSessionLike {
  id?: string | null;
  _rawId?: string | null;
}

export interface OpencodeProjectConnectionEntry<TConnection> {
  projectKey: string;
  connection: TConnection;
}

const PROJECT_KEY_SEPARATOR = "\u0000";

function normalizeProjectDirectory(directory: string) {
  return normalize(directory.trim());
}

export class OpencodeProjectRegistry<TConnection> {
  readonly connections = new Map<string, TConnection>();
  readonly sessionProjectKeys = new Map<string, string>();
  readonly questionProjectKeys = new Map<string, string>();

  createProjectKey(workspaceId: string | null | undefined, directory: string) {
    return `${workspaceId?.trim() || ""}${PROJECT_KEY_SEPARATOR}${normalizeProjectDirectory(
      directory,
    )}`;
  }

  getWorkspaceIdFromProjectKey(projectKey: string) {
    return projectKey.split(PROJECT_KEY_SEPARATOR, 1)[0] ?? "";
  }

  setConnection(
    target: { directory: string; workspaceId?: string | null },
    connection: TConnection,
  ) {
    const projectKey = this.createProjectKey(target.workspaceId, target.directory);
    this.connections.set(projectKey, connection);
    return { projectKey, connection } satisfies OpencodeProjectConnectionEntry<TConnection>;
  }

  getConnection(projectKey: string) {
    return this.connections.get(projectKey) ?? null;
  }

  deleteConnection(projectKey: string) {
    const connection = this.connections.get(projectKey) ?? null;
    if (connection) {
      this.connections.delete(projectKey);
    }
    return connection;
  }

  getExactConnectionEntry(
    target: OpencodeProjectTarget,
  ): OpencodeProjectConnectionEntry<TConnection> | null {
    if (typeof target.directory !== "string" || !target.directory.trim()) return null;
    const projectKey = this.createProjectKey(target.workspaceId, target.directory);
    const connection = this.connections.get(projectKey);
    return connection ? { projectKey, connection } : null;
  }

  getSessionProjectKey(sessionId: string | null | undefined) {
    const key = String(sessionId ?? "").trim();
    return key ? (this.sessionProjectKeys.get(key) ?? null) : null;
  }

  getQuestionProjectKey(requestId: string | null | undefined) {
    const key = String(requestId ?? "").trim();
    return key ? (this.questionProjectKeys.get(key) ?? null) : null;
  }

  getMappedSessionConnectionEntry(
    sessionId: string | null | undefined,
  ): OpencodeProjectConnectionEntry<TConnection> | null {
    const projectKey = this.getSessionProjectKey(sessionId);
    if (!projectKey) return null;
    const connection = this.connections.get(projectKey);
    return connection ? { projectKey, connection } : null;
  }

  getMappedQuestionConnectionEntry(
    requestId: string | null | undefined,
  ): OpencodeProjectConnectionEntry<TConnection> | null {
    const projectKey = this.getQuestionProjectKey(requestId);
    if (!projectKey) return null;
    const connection = this.connections.get(projectKey);
    return connection ? { projectKey, connection } : null;
  }

  rememberSession(projectKey: string, sessionId: string | null | undefined) {
    const key = String(sessionId ?? "").trim();
    if (!key) return;
    this.sessionProjectKeys.set(key, projectKey);
  }

  rememberSessions(projectKey: string, sessions: readonly OpencodeProjectSessionLike[]) {
    for (const session of sessions) {
      this.rememberSession(projectKey, session._rawId ?? session.id);
    }
  }

  deleteSession(sessionId: string | null | undefined) {
    const key = String(sessionId ?? "").trim();
    if (!key) return;
    this.sessionProjectKeys.delete(key);
  }

  rememberQuestion(projectKey: string, requestId: string | null | undefined) {
    const key = String(requestId ?? "").trim();
    if (!key) return;
    this.questionProjectKeys.set(key, projectKey);
  }

  deleteQuestion(requestId: string | null | undefined) {
    const key = String(requestId ?? "").trim();
    if (!key) return;
    this.questionProjectKeys.delete(key);
  }

  removeProject(projectKey: string) {
    const connection = this.deleteConnection(projectKey);

    const removedSessionIds: string[] = [];
    for (const [sessionId, candidateProjectKey] of this.sessionProjectKeys) {
      if (candidateProjectKey !== projectKey) continue;
      removedSessionIds.push(sessionId);
      this.sessionProjectKeys.delete(sessionId);
    }

    const removedQuestionIds: string[] = [];
    for (const [requestId, candidateProjectKey] of this.questionProjectKeys) {
      if (candidateProjectKey !== projectKey) continue;
      removedQuestionIds.push(requestId);
      this.questionProjectKeys.delete(requestId);
    }

    return {
      connection,
      removedSessionIds,
      removedQuestionIds,
    };
  }

  entries() {
    return this.connections.entries();
  }

  values() {
    return this.connections.values();
  }

  clear() {
    this.connections.clear();
    this.sessionProjectKeys.clear();
    this.questionProjectKeys.clear();
  }

  get size() {
    return this.connections.size;
  }
}
