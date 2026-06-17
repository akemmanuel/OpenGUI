#!/usr/bin/env node
/**
 * Stub: scaffold a new managed harness (registry + meta + adapter + bridge registration).
 * See docs/harness-bridge-contract.md and docs/plans/contributor-experience-and-slop-removal.md Track 5.
 *
 * Usage: node scripts/scaffold-harness.mjs <harness-id>
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const id = process.argv[2];
if (!id || id.startsWith("-")) {
  console.error("Usage: node scripts/scaffold-harness.mjs <harness-id>");
  process.exit(1);
}

const idsSrc = readFileSync(join(root, "src/agents/harness-ids.ts"), "utf8");
if (idsSrc.includes(`"${id}"`)) {
  console.error(`Harness id "${id}" already appears in harness-ids.ts.`);
  process.exit(1);
}

const pascal = id
  .split("-")
  .map((p) => p.charAt(0).toUpperCase() + p.slice(1))
  .join("");

console.log(`
Scaffold not automated yet. Manual checklist for harness "${id}":

1. src/agents/harness-ids.ts — add to HARNESS_ID_VALUES + HarnessId union
2. src/agents/harness-registry.ts — HARNESS_REGISTRY row (label, cliCommand)
3. src/agents/cli-harness-factory.ts — HARNESS_BACKEND_META entry + normalizeEvent
4. packages/runtime/src/adapters/${id}-bridge.ts — setup${pascal}Bridge
5. packages/runtime/src/harness-bridge-registrations.ts — BRIDGE_SETUP_BY_HARNESS_ID["${id}"]
6. pnpm run slop-check && vp test src/agents/harness-registry.test.ts

Copy an existing adapter (e.g. codex-bridge.ts) as a starting point.
`);
