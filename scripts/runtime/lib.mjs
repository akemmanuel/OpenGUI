/**
 * Shared helpers for @opengui/runtime probe scripts (read-only, no prompts).
 */
import { homedir } from "node:os";
import { resolve } from "node:path";

export function parseArgs(argv) {
  const args = argv.slice(2);
  const flags = {
    directory: process.env.OPENGUI_RUNTIME_DIRECTORY?.trim() || "",
    harness: (process.env.OPENGUI_RUNTIME_HARNESS || "pi").trim(),
    dataDir: process.env.OPENGUI_RUNTIME_DATA_DIR?.trim() || "",
    json: false,
    help: false,
    limit: 20,
    sessionId: "",
    allHarnesses: false,
  };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--help" || arg === "-h") flags.help = true;
    else if (arg === "--json") flags.json = true;
    else if (arg === "--all-harnesses") flags.allHarnesses = true;
    else if (arg === "--directory" || arg === "-d")
      flags.directory = String(args[++i] ?? "").trim();
    else if (arg === "--harness" || arg === "-H") flags.harness = String(args[++i] ?? "pi").trim();
    else if (arg === "--data-dir") flags.dataDir = String(args[++i] ?? "").trim();
    else if (arg === "--limit") flags.limit = Math.max(1, Number(args[++i]) || 20);
    else if (arg === "--session" || arg === "-s") flags.sessionId = String(args[++i] ?? "").trim();
    else if (!arg.startsWith("-") && !flags.directory) flags.directory = arg.trim();
  }
  return flags;
}

export function usageLines(scriptName, extra = []) {
  return [
    `Usage: vp node scripts/runtime/${scriptName} [options] [directory]`,
    "",
    "Environment:",
    "  OPENGUI_RUNTIME_DIRECTORY   Default repo path",
    "  OPENGUI_RUNTIME_HARNESS     Default harness (pi, opencode, claude-code, codex)",
    "  OPENGUI_RUNTIME_DATA_DIR    Runtime data dir (default: ~/.config/opengui-runtime-probes)",
    "",
    "Options:",
    "  -d, --directory <path>      Canonical directory under allowedRoots",
    "  -H, --harness <id>          Harness id",
    "  --data-dir <path>           Persistent runtime data",
    "  --json                      Print JSON only",
    "  -h, --help                  This help",
    ...extra,
    "",
    "Read-only: no prompts, no session create, no agent sends.",
  ];
}

export function resolveDirectory(flags) {
  const directory = flags.directory || process.cwd();
  return resolve(directory);
}

export async function createRuntime(flags) {
  const { createOpenGUI } = await import("@opengui/runtime");
  const directory = resolveDirectory(flags);
  const allowedRoots = [resolve(directory)];
  const dataDir =
    flags.dataDir || resolve(homedir(), ".config", "opengui-runtime-probes", String(process.pid));
  const og = await createOpenGUI({ allowedRoots, dataDir });
  return { og, directory, dataDir };
}

export function logSection(title) {
  console.log(`\n=== ${title} ===`);
}

export function printJson(value) {
  console.log(JSON.stringify(value, null, 2));
}

/** Summarize providers/agents/commands from loadResources (models live here for many harnesses). */
export function summarizeResources(bundle) {
  const providers = bundle?.providersData;
  const providerList = Array.isArray(providers?.providers)
    ? providers.providers
    : Array.isArray(providers)
      ? providers
      : providers && typeof providers === "object"
        ? Object.values(providers)
        : [];
  const models = [];
  for (const p of providerList) {
    if (!p || typeof p !== "object") continue;
    const id = p.id ?? p.providerID ?? p.name;
    const modelMap = p.models ?? p.modelIDs;
    if (modelMap && typeof modelMap === "object") {
      for (const modelId of Object.keys(modelMap)) {
        models.push({ provider: String(id ?? "?"), modelId });
      }
    }
  }
  const agents = Array.isArray(bundle?.agentsData) ? bundle.agentsData : [];
  const commands = Array.isArray(bundle?.commandsData) ? bundle.commandsData : [];
  return {
    providerCount: providerList.length,
    modelCount: models.length,
    models: models.slice(0, 40),
    agents: agents.slice(0, 20).map((a) => ({
      id: a?.id ?? a?.name,
      name: a?.name ?? a?.id,
    })),
    commands: commands.slice(0, 20).map((c) => ({
      id: c?.id ?? c?.name,
      name: c?.name ?? c?.id,
    })),
  };
}

/** Rough message count from harness-specific transcript shapes. */
export function summarizeMessages(payload) {
  if (Array.isArray(payload)) {
    return { shape: "array", count: payload.length, sample: payload.slice(0, 2) };
  }
  if (payload && typeof payload === "object") {
    const entries = payload.entries ?? payload.messages ?? payload.data;
    if (Array.isArray(entries)) {
      return { shape: "object.entries", count: entries.length, sample: entries.slice(0, 2) };
    }
  }
  return { shape: typeof payload, preview: payload };
}
