import {
  createCliHarnessNormalizer,
  LOCAL_CLI_WORKSPACE,
  makeLocalCliCapabilities,
} from "./cli-harness-factory.ts";

export const PI_CAPABILITIES = makeLocalCliCapabilities({
  messagePaging: false,
  commands: true,
  compact: true,
  fork: true,
  providerAuth: true,
});

export const PI_WORKSPACE = LOCAL_CLI_WORKSPACE;

export const normalizePiEvent = createCliHarnessNormalizer("pi");
