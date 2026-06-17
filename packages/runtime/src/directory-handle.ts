import type { HarnessId } from "../../../src/agents/index.ts";
import type { DirectoryRegisterResult } from "../../../src/protocol/client.ts";
import type { HarnessHandle } from "./open-gui.ts";

/** Canonical directory under `allowedRoots` (ADR 0007 Phase A). */
export interface DirectoryHandle {
  /** Resolved absolute path for this scope. */
  readonly path: string;
  /** Register harness adapters for this directory (idempotent). */
  connect(input?: { harnesses?: HarnessId[] }): Promise<DirectoryRegisterResult>;
  /** Release harness connections for this directory. */
  release(input?: { harnesses?: HarnessId[] }): Promise<void>;
  /**
   * Harness handle with `directory` fixed to this scope.
   * Session/list/prompt methods omit `directory` when using this handle.
   */
  harness(harnessId: HarnessId): HarnessHandle;
}

export interface CreateDirectoryHandleInput {
  readonly path: string;
  readonly runtime: {
    harness(harnessId: HarnessId): HarnessHandle;
    createBoundHarness(harnessId: HarnessId, directoryPath: string): HarnessHandle;
    registerDirectory(input: {
      directory: string;
      harnessIds?: HarnessId[];
    }): Promise<DirectoryRegisterResult>;
    releaseDirectory(input: { directory: string; harnessIds?: HarnessId[] }): Promise<void>;
  };
}

export function createDirectoryHandle(input: CreateDirectoryHandleInput): DirectoryHandle {
  const { path, runtime } = input;
  return {
    path,
    connect: (opts) => runtime.registerDirectory({ directory: path, harnessIds: opts?.harnesses }),
    release: (opts) => runtime.releaseDirectory({ directory: path, harnessIds: opts?.harnesses }),
    harness: (harnessId) => runtime.createBoundHarness(harnessId, path),
  };
}
