#!/usr/bin/env node
/**
 * Smoke test for OpenGUI's local Claude SDK replacement.
 *
 * It does not call real Claude. Instead it creates a tiny fake `claude` CLI that
 * speaks the SDK JSONL/control protocol enough to verify the parts used by
 * claude-code-bridge.ts: query iteration, initialize, supportedModels,
 * canUseTool permissions, hooks, interrupt, and close/return cleanup.
 *
 * Run from OpenGUI:
 *   vp node scripts/test-claude-sdk-replacement.mjs
 */

import assert from "node:assert/strict";
import { mkdtemp, writeFile, chmod, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { query } from "../BetterSDK/dist/index.js";

const temp = await mkdtemp(join(tmpdir(), "opengui-claude-sdk-smoke-"));
const mockClaude = join(temp, "mock-claude.mjs");

await writeFile(
  mockClaude,
  `#!/usr/bin/env node
import { createInterface } from 'node:readline';

let initialized = false;
let hookId = null;
let userSeen = false;
let permissionAnswered = false;
let hookAnswered = false;

function send(obj) { process.stdout.write(JSON.stringify(obj) + '\\n'); }
function controlSuccess(request_id, response = {}) {
  send({ type: 'control_response', response: { subtype: 'success', request_id, response } });
}

const rl = createInterface({ input: process.stdin });
rl.on('line', (line) => {
  if (!line.trim()) return;
  const msg = JSON.parse(line);

  if (msg.type === 'control_request') {
    const subtype = msg.request?.subtype;
    if (subtype === 'initialize') {
      initialized = true;
      hookId = msg.request?.hooks?.PreToolUse?.[0]?.hookCallbackIds?.[0] ?? null;
      controlSuccess(msg.request_id, {
        pid: process.pid,
        supportedCommands: ['interrupt'],
        supportedModels: [
          { value: 'default', displayName: 'Sonnet', supportsEffort: true, supportedEffortLevels: ['low', 'medium', 'high', 'max'] },
          { value: 'haiku', displayName: 'Haiku' }
        ]
      });
      return;
    }
    if (subtype === 'supported_models') {
      controlSuccess(msg.request_id, { supportedModels: [{ value: 'default', displayName: 'Sonnet' }] });
      return;
    }
    if (subtype === 'interrupt') {
      controlSuccess(msg.request_id, { ok: true });
      return;
    }
    controlSuccess(msg.request_id, { ok: true, subtype });
    return;
  }

  if (msg.type === 'control_response') {
    if (msg.response?.request_id === 'perm_1') permissionAnswered = msg.response?.response?.behavior === 'allow';
    if (msg.response?.request_id === 'hook_1') hookAnswered = msg.response?.subtype === 'success';
    if (permissionAnswered && (!hookId || hookAnswered)) {
      send({ type: 'assistant', session_id: 'mock-session', message: { id: 'msg_assistant', model: 'mock-model', content: [{ type: 'text', text: 'ok' }] } });
      send({ type: 'result', session_id: 'mock-session', is_error: false, errors: [] });
      process.exit(0);
    }
    return;
  }

  if (msg.type === 'user') {
    userSeen = true;
    send({ type: 'system', subtype: 'init', session_id: 'mock-session' });
    send({
      type: 'control_request',
      request_id: 'perm_1',
      request: {
        subtype: 'can_use_tool',
        tool_name: 'Write',
        input: { file_path: 'README.md' },
        permission_suggestions: [{ type: 'addRules', rules: [{ toolName: 'Write', ruleContent: 'Write(README.md)' }], behavior: 'allow' }],
        tool_use_id: 'tool_1',
        title: 'Claude wants to write README.md',
        display_name: 'Write file',
        description: 'Mock permission request'
      }
    });
    if (hookId) {
      send({ type: 'control_request', request_id: 'hook_1', request: { subtype: 'hook_callback', callback_id: hookId, input: { tool_name: 'Write' }, tool_use_id: 'tool_1' } });
    }
  }
});

process.on('beforeExit', () => {
  if (!initialized || !userSeen || !permissionAnswered || (hookId && !hookAnswered)) process.exitCode = 2;
});
`,
);
await chmod(mockClaude, 0o755);

try {
  let permissionCalled = false;
  let hookCalled = false;

  const handle = query({
    prompt: "hello from OpenGUI smoke test",
    options: {
      cwd: process.cwd(),
      pathToClaudeCodeExecutable: mockClaude,
      includePartialMessages: true,
      settingSources: ["user", "project", "local"],
      tools: { type: "preset", preset: "claude_code" },
      canUseTool: async (toolName, input, context) => {
        permissionCalled = true;
        assert.equal(toolName, "Write");
        assert.equal(input.file_path, "README.md");
        assert.equal(context.toolUseID, "tool_1");
        assert.equal(context.title, "Claude wants to write README.md");
        assert.equal(context.suggestions?.[0]?.type, "addRules");
        return { behavior: "allow", updatedInput: input };
      },
      hooks: {
        PreToolUse: [
          {
            matcher: "Write",
            hooks: [async (input, toolUseID) => {
              hookCalled = true;
              assert.equal(toolUseID, "tool_1");
              assert.equal(input.tool_name, "Write");
              return { continue: true };
            }],
          },
        ],
      },
    },
  });

  const init = await handle.initializationResult();
  assert.equal(typeof init?.pid, "number");

  const models = await handle.supportedModels();
  assert.equal(models[0].value, "default");

  await handle.interrupt();

  const messages = [];
  for await (const message of handle) messages.push(message);

  assert.equal(permissionCalled, true);
  assert.equal(hookCalled, true);
  assert.equal(messages.some((m) => m.type === "system" && m.subtype === "init"), true);
  assert.equal(messages.some((m) => m.type === "assistant"), true);
  assert.equal(messages.some((m) => m.type === "result"), true);

  console.log("✅ OpenGUI Claude SDK replacement smoke test passed");
} finally {
  await rm(temp, { recursive: true, force: true });
}

