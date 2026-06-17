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
    name: "no createBackendIdCodec outside id-codec",
    cmd: `rg 'createBackendIdCodec' src/ packages/ --glob '!**/id-codec.ts' --glob '!**/id-codec.test.ts' 2>/dev/null || true`,
    forbid: (out) => out.trim().length > 0,
  },
  {
    name: "no tagBackendSession in product code",
    cmd: `rg 'tagBackendSession' src/ packages/ --glob '!**/shared.ts' --glob '!**/*.test.*' 2>/dev/null || true`,
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
