// @ts-nocheck
import { normalize } from "node:path";

export class OpencodeProjectRegistry {
  connections = new Map();
  questionProjectKeys = new Map();

  createProjectKey(_workspaceId, directory) {
    return normalize(String(directory || "").trim());
  }

  getWorkspaceIdFromProjectKey(_projectKey) {
    return "";
  }

  setConnection(target, connection) {
    const projectKey = this.createProjectKey(null, target.directory);
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
    const projectKey = this.createProjectKey(null, target.directory);
    const connection = this.connections.get(projectKey);
    return connection ? { projectKey, connection } : null;
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
