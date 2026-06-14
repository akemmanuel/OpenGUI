// @ts-nocheck
import { normalizeProjectPath } from "./src/lib/path.ts";

const PROJECT_KEY_SEPARATOR = "\u0000";

export class OpencodeProjectRegistry {
  connections = new Map();
  questionProjectKeys = new Map();

  createProjectKey(workspaceId, directory) {
    return `${String(workspaceId || "")}${PROJECT_KEY_SEPARATOR}${normalizeProjectPath(
      String(directory || ""),
    )}`;
  }

  getWorkspaceIdFromProjectKey(projectKey) {
    const raw = String(projectKey || "");
    const idx = raw.indexOf(PROJECT_KEY_SEPARATOR);
    return idx < 0 ? "" : raw.slice(0, idx);
  }

  setConnection(target, connection) {
    const projectKey = this.createProjectKey(target.workspaceId, target.directory);
    this.connections.set(projectKey, connection);
    return { projectKey, connection };
  }

  getConnection(projectKey) {
    return this.connections.get(projectKey) ?? null;
  }

  deleteConnection(projectKey) {
    const connection = this.connections.get(projectKey) ?? null;
    if (connection) this.connections.delete(projectKey);
    return connection;
  }

  getExactConnectionEntry(target) {
    if (typeof target.directory !== "string" || !target.directory.trim()) return null;
    const projectKey = this.createProjectKey(target.workspaceId, target.directory);
    const connection = this.connections.get(projectKey);
    return connection ? { projectKey, connection } : null;
  }

  getDirectoryConnectionEntry(target) {
    const directory = normalizeProjectPath(String(target.directory || ""));
    if (!directory) return null;
    const exact = this.getExactConnectionEntry(target);
    if (exact) return exact;
    const matches = [];
    for (const [projectKey, connection] of this.connections) {
      const idx = String(projectKey).indexOf(PROJECT_KEY_SEPARATOR);
      const keyWorkspaceId = idx < 0 ? "" : String(projectKey).slice(0, idx);
      const keyDirectory = idx < 0 ? String(projectKey) : String(projectKey).slice(idx + 1);
      if (target.workspaceId && keyWorkspaceId && keyWorkspaceId !== target.workspaceId) continue;
      if (keyDirectory === directory) matches.push({ projectKey, connection });
    }
    return matches.length === 1 ? matches[0] : null;
  }

  getQuestionProjectKey(requestId) {
    const key = String(requestId ?? "").trim();
    return key ? (this.questionProjectKeys.get(key) ?? null) : null;
  }

  getMappedQuestionConnectionEntry(requestId) {
    const projectKey = this.getQuestionProjectKey(requestId);
    if (!projectKey) return null;
    const connection = this.connections.get(projectKey);
    return connection ? { projectKey, connection } : null;
  }

  rememberQuestion(projectKey, requestId) {
    const key = String(requestId ?? "").trim();
    if (key) this.questionProjectKeys.set(key, projectKey);
  }

  deleteQuestion(requestId) {
    const key = String(requestId ?? "").trim();
    if (key) this.questionProjectKeys.delete(key);
  }

  removeProject(projectKey) {
    const connection = this.deleteConnection(projectKey);
    const removedQuestionIds = [];
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
