#!/usr/bin/env node
/**
 * Lightweight slop guardrails (see docs/plans/contributor-experience-and-slop-removal.md).
 * Exit 1 if forbidden patterns appear outside allowed paths.
 */
import { execSync } from "node:child_process";

const checks = [
  {
    name: "no /api/projects routes",
    cmd: `rg -l '/api/projects' server/ src/protocol 2>/dev/null || true`,
    forbid: (out) => out.trim().length > 0,
  },
  {
    name: "no connectProject in frontend protocol",
    cmd: `rg -l 'connectProject|disconnectProject' src/ --glob '!**/*.test.*' 2>/dev/null || true`,
    forbid: (out) => out.trim().length > 0,
  },
  {
    name: "no sync:true session list client",
    cmd: `rg 'sync:\\s*true' src/protocol 2>/dev/null || true`,
    forbid: (out) => out.trim().length > 0,
  },
  {
    name: "listSessionRecords not in server (non-test)",
    cmd: `rg 'listSessionRecords\\(' server/ --glob '!**/*.test.*' 2>/dev/null || true`,
    forbid: (out) => out.trim().length > 0,
  },
  {
    name: "no listProjectSessionQueues alias",
    cmd: `rg 'listProjectSessionQueues' server/ src/ 2>/dev/null || true`,
    forbid: (out) => out.trim().length > 0,
  },
  {
    name: "no sessionRecordFromWireIdentity",
    cmd: `rg 'sessionRecordFromWireIdentity' server/ src/ 2>/dev/null || true`,
    forbid: (out) => out.trim().length > 0,
  },
  {
    name: "no createBackendIdCodec",
    cmd: `rg 'createBackendIdCodec' src/ packages/ 2>/dev/null || true`,
    forbid: (out) => out.trim().length > 0,
  },
  {
    name: "no tagBackendSession",
    cmd: `rg 'tagBackendSession' src/ packages/ 2>/dev/null || true`,
    forbid: (out) => out.trim().length > 0,
  },
  {
    name: "no OpenGuiClient listDirectorySessions",
    cmd: `rg 'listDirectorySessions' src/protocol/client.ts src/protocol/http-client.ts 2>/dev/null || true`,
    forbid: (out) => out.trim().length > 0,
  },
  {
    name: "no listDirectorySessions in frontend hooks",
    cmd: `rg 'listDirectorySessions' src/hooks src/features --glob '!**/*.test.*' 2>/dev/null || true`,
    forbid: (out) => out.trim().length > 0,
  },
  {
    name: "no sync flag in session-query",
    cmd: `rg '\\bsync\\b' server/services/session-query.ts 2>/dev/null || true`,
    forbid: (out) => out.trim().length > 0,
  },
  {
    name: "no BackendIdCodec alias",
    cmd: `rg 'BackendIdCodec' src/ packages/ 2>/dev/null || true`,
    forbid: (out) => out.trim().length > 0,
  },
  {
    name: "no ensureSession on harness list path",
    cmd: `rg 'ensureSession' server/services/session-harness-list.ts server/services/session-query.ts 2>/dev/null || true`,
    forbid: (out) => out.trim().length > 0,
  },
  {
    name: "no product listSessions on SessionDispatchIndex",
    cmd: `rg 'listSessions(' server/services/session-dispatch-index.ts 2>/dev/null || true`,
    forbid: (out) => out.trim().length > 0,
  },
  {
    name: "no session-service.ts filename (renamed to session-dispatch-index)",
    cmd: `test -f server/services/session-service.ts && echo found || true`,
    forbid: (out) => out.trim().length > 0,
  },
  {
    name: "backend routes use @opengui/protocol not src/agents",
    cmd: `rg 'from "../../../../src/agents' packages/backend/src 2>/dev/null || true`,
    forbid: (out) => out.trim().length > 0,
  },
];

let failed = 0;
for (const { name, cmd, forbid } of checks) {
  const out = execSync(cmd, { encoding: "utf8", maxBuffer: 1024 * 1024 }).trim();
  if (forbid(out)) {
    console.error(`FAIL: ${name}`);
    if (out) console.error(out);
    failed += 1;
  } else {
    console.log(`ok: ${name}`);
  }
}

if (failed) {
  console.error(
    `\n${failed} slop check(s) failed. See docs/plans/contributor-experience-and-slop-removal.md`,
  );
  process.exit(1);
}
console.log("\nAll slop checks passed.");
