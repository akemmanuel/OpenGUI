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
  {
    name: "no frontend-live-session-bridge module-global map",
    cmd: `test -f src/hooks/frontend-live-session-bridge.ts && echo found || true`,
    forbid: (out) => out.trim().length > 0,
  },
  {
    name: "LiveSessionProjection only in session-transcript feature",
    cmd: `rg 'new LiveSessionProjection' src --glob '!**/*.test.*' --glob '!src/features/session-transcript/**' 2>/dev/null || true`,
    forbid: (out) => out.trim().length > 0,
  },
  {
    name: "no agent-transcript-reducer module",
    cmd: `test -f src/hooks/agent-transcript-reducer.ts && echo found || true`,
    forbid: (out) => out.trim().length > 0,
  },
  {
    name: "no TRANSCRIPT_ actions in agent-reducer",
    cmd: `rg 'TRANSCRIPT_' src/hooks/agent-reducer.ts 2>/dev/null || true`,
    forbid: (out) => out.trim().length > 0,
  },
  {
    name: "no SET_MESSAGES or LOAD_CHILD_SESSION in hooks",
    cmd: `rg 'SET_MESSAGES|LOAD_CHILD_SESSION' src/hooks --glob '!**/*.test.*' 2>/dev/null || true`,
    forbid: (out) => out.trim().length > 0,
  },
  {
    name: "no _sessionBuffers in frontend hooks",
    cmd: `rg '_sessionBuffers' src/hooks --glob '!**/*.test.*' 2>/dev/null || true`,
    forbid: (out) => out.trim().length > 0,
  },
  {
    name: "no local Queued prompt mutation actions",
    cmd: `rg 'QUEUE_(ADD|SHIFT|REMOVE|REORDER|UPDATE)' src/hooks src/features --glob '!**/*.test.*' 2>/dev/null || true`,
    forbid: (out) => out.trim().length > 0,
  },
  {
    name: "no VirtualMessageScroller in message list",
    cmd: `rg 'VirtualMessageScroller|useVirtualMessageScroller|@tanstack/react-virtual' src/components/message-list --glob '!**/*.test.*' 2>/dev/null || true`,
    forbid: (out) => out.trim().length > 0,
  },
  {
    name: "no harness-native part deltas in frontend hooks/features/components",
    cmd: `rg 'message\\.part\\.(delta|updated)|message\\.replaced' src/hooks src/features src/components --glob '!**/*.test.*' 2>/dev/null || true`,
    forbid: (out) => out.trim().length > 0,
  },
  {
    name: "harness.on(event) only in diagnostics script",
    cmd: `rg -l 'harness\\.on\\("event"' scripts 2>/dev/null | rg -v '^scripts/runtime/debug-bridges\\.mjs$' || true`,
    forbid: (out) => out.trim().length > 0,
  },
  {
    name: "no ingestHarnessEvent on backend or frontend product paths",
    cmd: `rg 'ingestHarnessEvent' server/ src/hooks src/features --glob '!**/*.test.*' 2>/dev/null || true`,
    forbid: (out) => out.trim().length > 0,
  },
  {
    name: "LiveSessionEventNormalizer instantiated only in live-session bus",
    cmd: `rg 'new LiveSessionEventNormalizer' packages/runtime src server --glob '!**/*.test.*' --glob '!packages/runtime/src/live-session-events/live-session-event-bus.ts' --glob '!packages/runtime/src/live-session-events/live-session-normalizer.ts' 2>/dev/null || true`,
    forbid: (out) => out.trim().length > 0,
  },
  {
    name: "harnessEventToAgentStreamEvents only in runtime agent-stream",
    cmd: `rg 'harnessEventToAgentStreamEvents' src packages --glob '!**/*.test.*' --glob '!packages/runtime/src/agent-stream.ts' --glob '!packages/runtime/src/index.ts' 2>/dev/null || true`,
    forbid: (out) => out.trim().length > 0,
  },
  {
    name: "projected transcript ingest only in backend subscription",
    cmd: `rg 'ingestProjectedTranscriptEvent' src/hooks/agent-backend-events.ts 2>/dev/null || true`,
    forbid: (out) => out.trim().length > 0,
  },
  {
    name: "no transcript.message in runtime session transcripts",
    cmd: `rg "type: \\"transcript\\.message\\"" packages/runtime/src/session-transcripts.ts 2>/dev/null || true`,
    forbid: (out) => out.trim().length > 0,
  },
  {
    name: "no legacy chat/project placement metadata",
    cmd: `rg 'originMode|nativeProjectDir|assignedProjectDir|detachedFromProject|pendingDirectoryChangeNotice|hideSystemAppendBlocks|getEffectiveSessionDirectory|chat-infra' src/ --glob '!**/*.test.*' 2>/dev/null || true`,
    forbid: (out) => out.trim().length > 0,
  },
  {
    name: "each harness bridge has mapping module",
    cmd: `for h in pi codex opencode claude-code grok-build; do test -f "packages/runtime/src/adapters/$h-bridge-mapping.ts" || echo "missing $h"; done`,
    forbid: (out) => out.trim().length > 0,
  },
  {
    name: "each harness bridge mapping has tests beside adapters",
    cmd: `for f in harness-adapter-kit pi-bridge-mapping codex-bridge-mapping opencode-bridge-mapping claude-code-bridge-mapping grok-build-bridge-mapping; do test -f "packages/runtime/src/adapters/__tests__/$f.test.ts" || echo "missing packages/runtime/src/adapters/__tests__/$f.test.ts"; done`,
    forbid: (out) => out.trim().length > 0,
  },
  {
    name: "pi and opencode bridge behavior modules have tests",
    cmd: `for f in pi-bridge-live-resolution pi-bridge-session-events pi-project-slot opencode-sse-lifecycle; do test -f "packages/runtime/src/adapters/__tests__/$f.test.ts" || echo "missing $f.test.ts"; done`,
    forbid: (out) => out.trim().length > 0,
  },
  {
    name: "runtime session-handle and transcript delta have tests",
    cmd: `for f in wait-until-idle transcript-part-delta harness-events-to-live; do test -f "packages/runtime/src/__tests__/$f.test.ts" || echo "missing $f.test.ts"; done`,
    forbid: (out) => out.trim().length > 0,
  },
  {
    name: "no @ts-nocheck in repo TypeScript",
    cmd: `rg -l '@ts-nocheck' packages/runtime lib --glob '*.ts' --glob '!packages/runtime/src/adapters/codex-bridge.ts' 2>/dev/null || true`,
    forbid: (out) => out.trim().length > 0,
  },
  {
    name: "no explicit any in runtime adapters (use unknown + narrowing)",
    cmd: `rg ': any\\b|<any>|as any\\b|any\\[\\]' packages/runtime/src/adapters --glob '*.ts' --glob '!**/*.test.ts' --glob '!codex-bridge.ts' 2>/dev/null || true`,
    forbid: (out) => out.trim().length > 0,
  },
  {
    name: "prefer harnessEventsToLiveSessionEvents at harness ingress",
    cmd: `rg 'harnessEventToAdapterObservations\\(' server/live-session-event-publish.ts packages/runtime/src/session-handle.ts 2>/dev/null || true`,
    forbid: (out) => out.trim().length > 0,
  },
  {
    name: "no lib/harness-adapter-kit (colocated under runtime adapters)",
    cmd: `test -f lib/harness-adapter-kit.ts && echo found || true`,
    forbid: (out) => out.trim().length > 0,
  },
  {
    name: "web-server is thin entry (no product routes in server/)",
    cmd: `rg 'registerProductApiRoutes|registerHostTransportRoutes' server/ --glob '*.ts' 2>/dev/null || true`,
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
