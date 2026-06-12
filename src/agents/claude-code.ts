import {
  createCliHarnessNormalizer,
  LOCAL_CLI_WORKSPACE,
  makeLocalCliCapabilities,
} from "./cli-harness-factory.ts";

export const CLAUDE_CODE_CAPABILITIES = makeLocalCliCapabilities({
  messagePaging: true,
  commands: true,
  compact: true,
  fork: true,
  permissions: true,
});

export const CLAUDE_CODE_WORKSPACE = LOCAL_CLI_WORKSPACE;

export const normalizeClaudeCodeEvent = createCliHarnessNormalizer("claude-code");
