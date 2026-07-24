/**
 * Fetches provider icons from models.dev into src/components/provider-icons/svgs/.
 *
 * ProviderIcon resolves icons through the Vite glob manifest in types.ts, so this
 * script intentionally does not generate a sprite sheet or rewrite types.ts.
 *
 * Usage: vp node scripts/fetch-provider-icons.ts
 */

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

const MODELS_URL = process.env.OPENGUI_MODELS_URL || "https://models.dev";
const ICONS_DIR = path.join("src", "components", "provider-icons", "svgs");

interface FetchProviderIconsOptions {
  modelsUrl: string;
  iconsDir: string;
  fetch: (url: string) => Promise<Response>;
  mkdir: (path: string, options: { recursive: true }) => Promise<unknown>;
  writeFile: (path: string, contents: string) => Promise<unknown>;
}

export async function fetchProviderIcons(options: FetchProviderIconsOptions) {
  const apiRes = await options.fetch(`${options.modelsUrl}/api.json`);
  if (!apiRes.ok) {
    throw new Error(`Failed to fetch api.json: ${apiRes.status}`);
  }
  const api = (await apiRes.json()) as Record<string, unknown>;
  const providerIds = Object.keys(api);
  await options.mkdir(options.iconsDir, { recursive: true });
  await options.writeFile(path.join(options.iconsDir, ".gitkeep"), "");

  const succeeded: string[] = [];
  const failed: string[] = [];

  // Fetch all icons in parallel (batched)
  const BATCH_SIZE = 20;
  for (let i = 0; i < providerIds.length; i += BATCH_SIZE) {
    const batch = providerIds.slice(i, i + BATCH_SIZE);
    const results = await Promise.allSettled(
      batch.map(async (id) => {
        const url = `${options.modelsUrl}/logos/${id}.svg`;
        const res = await options.fetch(url);
        if (!res.ok) {
          throw new Error(`${res.status} for ${id}`);
        }
        const svg = await res.text();
        // Only keep valid SVGs
        if (!svg.includes("<svg")) {
          throw new Error(`Invalid SVG for ${id}`);
        }
        await options.writeFile(path.join(options.iconsDir, `${id}.svg`), svg);
        return id;
      }),
    );

    for (const result of results) {
      if (result.status === "fulfilled") {
        succeeded.push(result.value);
      } else {
        const idx = results.indexOf(result);
        if (batch[idx]) failed.push(batch[idx]);
      }
    }
  }

  succeeded.sort();
  failed.sort();
  return { succeeded, failed };
}

async function main() {
  console.info(`Fetching provider list from ${MODELS_URL}/api.json ...`);
  const result = await fetchProviderIcons({
    modelsUrl: MODELS_URL,
    iconsDir: ICONS_DIR,
    fetch,
    mkdir,
    writeFile,
  });
  console.info(`Downloaded ${result.succeeded.length} icons, ${result.failed.length} failed`);
  if (result.failed.length > 0) console.info(`Failed: ${result.failed.join(", ")}`);

  console.info("Done!");
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename)) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
