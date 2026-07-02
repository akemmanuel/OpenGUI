import { homedir } from "node:os";

/** Isolated runtime data dir for integration tests (per process). */
export function joinTmpRuntimeDir(): string {
  return `${homedir()}/.cache/opengui-runtime-test-${process.pid}`;
}
