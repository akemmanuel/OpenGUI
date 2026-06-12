import {
  createCliHarnessNormalizer,
  LOCAL_CLI_WORKSPACE,
  makeLocalCliCapabilities,
} from "./cli-harness-factory.ts";

export const CODEX_CAPABILITIES = makeLocalCliCapabilities({
  messagePaging: false,
});

export const CODEX_WORKSPACE = LOCAL_CLI_WORKSPACE;

export const normalizeCodexEvent = createCliHarnessNormalizer("codex");
