/**
 * In-memory directory scope for harness execution (not a Frontend Project or SQLite project row).
 */
export interface DirectoryScopeRef {
  id: string;
  path: string;
  canonicalPath: string;
  displayName: string;
  createdAt: string;
  updatedAt: string;
}
