import { normalizeProjectPath } from "../../../../src/lib/path.ts";

const PROJECT_KEY_SEPARATOR = "\u0000";

type ProjectTarget = {
  workspaceId?: string;
  directory?: string;
};

export class OpencodeProjectRegistry<Connection> {
  connections = new Map<string, Connection>();
  questionProjectKeys = new Map<string, string>();

  createProjectKey(workspaceId: string | undefined, directory: string | undefined) {
    return `${String(workspaceId || "")}${PROJECT_KEY_SEPARATOR}${normalizeProjectPath(
      String(directory || ""),
    )}`;
  }

  getWorkspaceIdFromProjectKey(projectKey: string) {
    const raw = String(projectKey || "");
    const idx = raw.indexOf(PROJECT_KEY_SEPARATOR);
    return idx < 0 ? "" : raw.slice(0, idx);
  }

  setConnection(target: ProjectTarget, connection: Connection) {
    const projectKey = this.createProjectKey(target.workspaceId, target.directory);
    this.connections.set(projectKey, connection);
    return { projectKey, connection };
  }

  getConnection(projectKey: string) {
    return this.connections.get(projectKey) ?? null;
  }

  deleteConnection(projectKey: string) {
    const connection = this.connections.get(projectKey) ?? null;
    if (connection) this.connections.delete(projectKey);
    return connection;
  }

  getExactConnectionEntry(target: ProjectTarget) {
    if (typeof target.directory !== "string" || !target.directory.trim()) return null;
    const projectKey = this.createProjectKey(target.workspaceId, target.directory);
    const connection = this.connections.get(projectKey);
    return connection ? { projectKey, connection } : null;
  }

  getDirectoryConnectionEntry(target: ProjectTarget) {
    const directory = normalizeProjectPath(String(target.directory || ""));
    if (!directory) return null;
    const exact = this.getExactConnectionEntry(target);
    if (exact) return exact;
    const matches: Array<{ projectKey: string; connection: Connection }> = [];
    for (const [projectKey, connection] of this.connections) {
      const idx = String(projectKey).indexOf(PROJECT_KEY_SEPARATOR);
      const keyWorkspaceId = idx < 0 ? "" : String(projectKey).slice(0, idx);
      const keyDirectory = idx < 0 ? String(projectKey) : String(projectKey).slice(idx + 1);
      if (target.workspaceId && keyWorkspaceId && keyWorkspaceId !== target.workspaceId) continue;
      if (keyDirectory === directory) matches.push({ projectKey, connection });
    }
    return matches.length === 1 ? matches[0] : null;
  }

  getQuestionProjectKey(requestId: string) {
    const key = String(requestId ?? "").trim();
    return key ? (this.questionProjectKeys.get(key) ?? null) : null;
  }

  getMappedQuestionConnectionEntry(requestId: string) {
    const projectKey = this.getQuestionProjectKey(requestId);
    if (!projectKey) return null;
    const connection = this.connections.get(projectKey);
    return connection ? { projectKey, connection } : null;
  }

  rememberQuestion(projectKey: string, requestId: string) {
    const key = String(requestId ?? "").trim();
    if (key) this.questionProjectKeys.set(key, projectKey);
  }

  deleteQuestion(requestId: string) {
    const key = String(requestId ?? "").trim();
    if (key) this.questionProjectKeys.delete(key);
  }

  removeProject(projectKey: string) {
    const connection = this.deleteConnection(projectKey);
    const removedQuestionIds: string[] = [];
    for (const [requestId, candidateProjectKey] of this.questionProjectKeys) {
      if (candidateProjectKey !== projectKey) continue;
      removedQuestionIds.push(requestId);
      this.questionProjectKeys.delete(requestId);
    }
    return { connection, removedSessionIds: [], removedQuestionIds };
  }

  entries() {
    return this.connections.entries();
  }

  values() {
    return this.connections.values();
  }

  clear() {
    this.connections.clear();
    this.questionProjectKeys.clear();
  }

  get size() {
    return this.connections.size;
  }
}
