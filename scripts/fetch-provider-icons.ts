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

const MODELS_URL = process.env.OPENCODE_MODELS_URL || "https://models.dev";
const ICONS_DIR = path.join("src", "components", "provider-icons", "svgs");

async function main() {
  console.info(`Fetching provider list from ${MODELS_URL}/api.json ...`);
  const apiRes = await fetch(`${MODELS_URL}/api.json`);
  if (!apiRes.ok) {
    throw new Error(`Failed to fetch api.json: ${apiRes.status}`);
  }
  const api = (await apiRes.json()) as Record<string, unknown>;
  const providerIds = Object.keys(api);
  console.info(`Found ${providerIds.length} providers`);

  // Ensure output directories exist
  await mkdir(ICONS_DIR, { recursive: true });
  await writeFile(path.join(ICONS_DIR, ".gitkeep"), "");

  const succeeded: string[] = [];
  const failed: string[] = [];

  // Fetch all icons in parallel (batched)
  const BATCH_SIZE = 20;
  for (let i = 0; i < providerIds.length; i += BATCH_SIZE) {
    const batch = providerIds.slice(i, i + BATCH_SIZE);
    const results = await Promise.allSettled(
      batch.map(async (id) => {
        const url = `${MODELS_URL}/logos/${id}.svg`;
        const res = await fetch(url);
        if (!res.ok) {
          throw new Error(`${res.status} for ${id}`);
        }
        const svg = await res.text();
        // Only keep valid SVGs
        if (!svg.includes("<svg")) {
          throw new Error(`Invalid SVG for ${id}`);
        }
        await writeFile(path.join(ICONS_DIR, `${id}.svg`), svg);
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

  console.info(`Downloaded ${succeeded.length} icons, ${failed.length} failed`);
  if (failed.length > 0) {
    console.info(`Failed: ${failed.join(", ")}`);
  }

  // Sort for deterministic output
  succeeded.sort();

  console.info("Done!");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
