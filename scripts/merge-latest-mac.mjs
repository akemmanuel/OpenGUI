import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const yaml = require("js-yaml");

function parseArgs() {
  const args = process.argv.slice(2);
  const opts = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--x64-dir") opts.x64Dir = resolve(args[++i]);
    else if (args[i] === "--arm64-dir") opts.arm64Dir = resolve(args[++i]);
    else if (args[i] === "--out-dir") opts.outDir = resolve(args[++i]);
  }
  if (!opts.x64Dir || !opts.arm64Dir || !opts.outDir) {
    console.error(
      "Usage: node merge-latest-mac.mjs --x64-dir <dir> --arm64-dir <dir> --out-dir <dir>",
    );
    process.exit(1);
  }
  return opts;
}

function readManifest(dir) {
  const candidates = ["latest-mac.yml", "latest-mac-arm64.yml", "latest-mac-x64.yml"];
  for (const name of candidates) {
    const p = join(dir, name);
    if (existsSync(p)) {
      console.log(`  found manifest: ${p}`);
      return yaml.load(readFileSync(p, "utf8"));
    }
  }
  console.error(`Manifest not found in ${dir}`);
  console.error(`  dir exists: ${existsSync(dir)}`);
  if (existsSync(dir)) {
    console.error(`  contents: ${readdirSync(dir).join(", ")}`);
  }
  process.exit(1);
}

function merge() {
  const { x64Dir, arm64Dir, outDir } = parseArgs();

  console.log(`Reading x64 manifest from: ${x64Dir}`);
  const x64 = readManifest(x64Dir);
  console.log(`Reading arm64 manifest from: ${arm64Dir}`);
  const arm64 = readManifest(arm64Dir);

  const releaseDate = new Date(
    Math.max(new Date(x64.releaseDate ?? 0).getTime(), new Date(arm64.releaseDate ?? 0).getTime()),
  ).toISOString();

  const merged = {
    version: x64.version ?? arm64.version,
    releaseDate,
    files: [...(x64.files ?? []), ...(arm64.files ?? [])],
  };

  if (!existsSync(outDir)) {
    mkdirSync(outDir, { recursive: true });
  }

  const outPath = join(outDir, "latest-mac.yml");
  writeFileSync(outPath, yaml.dump(merged, { lineWidth: -1, noRefs: true, sortKeys: false }));
  console.log(`Merged mac update manifest written to ${outPath}`);
  console.log(`  x64 files: ${(x64.files ?? []).length}`);
  console.log(`  arm64 files: ${(arm64.files ?? []).length}`);
  console.log(`  total: ${merged.files.length}`);
}

try {
  merge();
} catch (err) {
  console.error("Merge failed:", err.message);
  process.exit(1);
}
