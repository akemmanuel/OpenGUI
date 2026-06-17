/**
 * List all Pi harness models via @opengui/runtime (read-only loadResources).
 *
 *   node --experimental-strip-types scripts/list-pi-models.ts -d /path/to/repo
 *   vp node scripts/list-pi-models.ts -d .
 *
 * Requires `pi` on PATH. No prompts or session creates.
 */
import { homedir } from "node:os";
import { resolve } from "node:path";
import { createOpenGUI } from "@opengui/runtime";
import type { ProvidersData } from "../src/types/electron.d.ts";

function parseArgs(argv: string[]) {
  const args = argv.slice(2);
  let directory = process.env.OPENGUI_RUNTIME_DIRECTORY?.trim() || "";
  let json = false;
  let help = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === undefined) continue;
    if (arg === "-h" || arg === "--help") help = true;
    else if (arg === "--json") json = true;
    else if (arg === "-d" || arg === "--directory") directory = String(args[++i] ?? "").trim();
    else if (!arg.startsWith("-") && !directory) directory = arg.trim();
  }
  return { directory: directory || process.cwd(), json, help };
}

type ListedModel = {
  providerId: string;
  modelId: string;
  name: string;
  defaultForProvider: boolean;
};

function collectPiModels(providersData: ProvidersData): ListedModel[] {
  const defaults = providersData.default ?? {};
  const out: ListedModel[] = [];
  for (const provider of providersData.providers ?? []) {
    const providerId = provider.id ?? provider.name ?? "?";
    const modelMap = provider.models;
    if (!modelMap || typeof modelMap !== "object") continue;
    for (const [modelId, meta] of Object.entries(modelMap)) {
      const name =
        meta && typeof meta === "object" && "name" in meta && typeof meta.name === "string"
          ? meta.name
          : modelId;
      out.push({
        providerId: String(providerId),
        modelId,
        name,
        defaultForProvider: defaults[String(providerId)] === modelId,
      });
    }
  }
  out.sort((a, b) =>
    a.providerId === b.providerId
      ? a.modelId.localeCompare(b.modelId)
      : a.providerId.localeCompare(b.providerId),
  );
  return out;
}

const { directory: dirInput, json, help } = parseArgs(process.argv);

if (help) {
  console.log(`Usage: node --experimental-strip-types scripts/list-pi-models.ts [options] [directory]

Options:
  -d, --directory <path>   Repo path under allowedRoots (default: cwd)
  --json                   Print JSON array of models
  -h, --help               This help

Environment:
  OPENGUI_RUNTIME_DIRECTORY   Default directory
`);
  process.exit(0);
}

const directory = resolve(dirInput);
const dataDir = resolve(homedir(), ".config", "opengui-list-pi-models", String(process.pid));

const og = await createOpenGUI({
  allowedRoots: [directory],
  dataDir,
});

try {
  const dir = await og.at(directory);
  await dir.connect({ harnesses: ["pi"] });
  const pi = dir.harness("pi");
  const bundle = await pi.loadResources();
  const models = collectPiModels(bundle.providersData);

  if (json) {
    console.log(
      JSON.stringify({ directory, harnessId: "pi", count: models.length, models }, null, 2),
    );
  } else {
    console.log(`Pi models @ ${directory} (${models.length} total)\n`);
    let lastProvider = "";
    for (const m of models) {
      if (m.providerId !== lastProvider) {
        lastProvider = m.providerId;
        console.log(`\n[${m.providerId}]`);
      }
      const star = m.defaultForProvider ? " *" : "";
      console.log(`  ${m.modelId}${m.name !== m.modelId ? ` — ${m.name}` : ""}${star}`);
    }
    console.log("\n* default model for provider");
  }
} finally {
  await og.close();
}
