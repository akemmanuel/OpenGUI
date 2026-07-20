import type { SelectedModel } from "@opengui/protocol";

/** Canonical persisted workspace shape shared by host and renderer code. */
export interface Workspace {
  id: string;
  name: string;
  createdAt?: string;
  updatedAt?: string;
  settings?: Record<string, unknown>;
  serverUrl: string;
  username?: string;
  password?: string;
  authToken?: string;
  isLocal: boolean;
  projects: string[];
  selectedModel?: SelectedModel | null;
  selectedAgent?: string | null;
  lastActiveSessionId?: string | null;
}
