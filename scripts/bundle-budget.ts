import { readFile, stat } from "node:fs/promises";
import path from "node:path";

export const INITIAL_JAVASCRIPT_BUDGET_BYTES = 1_650_000;

export function measureInitialJavaScript(html: string, sizes: ReadonlyMap<string, number>) {
  const assets = [
    ...html.matchAll(/<(?:script|link)\b[^>]*(?:src|href)="(?:\.\/|\/)?(assets\/[^"?]+\.js)"/g),
  ]
    .map((match) => match[1])
    .filter((asset): asset is string => Boolean(asset));
  const uniqueAssets = [...new Set(assets)].sort();
  return {
    assets: uniqueAssets,
    bytes: uniqueAssets.reduce((total, asset) => total + (sizes.get(asset) ?? 0), 0),
  };
}

async function main() {
  const root = path.resolve(import.meta.dirname, "..");
  const html = await readFile(path.join(root, "dist/index.html"), "utf8");
  const referenced = [
    ...html.matchAll(/<(?:script|link)\b[^>]*(?:src|href)="(?:\.\/|\/)?(assets\/[^"?]+\.js)"/g),
  ].flatMap((match) => (match[1] ? [match[1]] : []));
  const sizes = new Map<string, number>();
  await Promise.all(
    referenced.map(async (asset) =>
      sizes.set(asset, (await stat(path.join(root, "dist", asset))).size),
    ),
  );
  const result = measureInitialJavaScript(html, sizes);
  console.info(
    `Initial JavaScript: ${result.bytes.toLocaleString()} bytes (${result.assets.join(", ")})`,
  );
  if (result.bytes > INITIAL_JAVASCRIPT_BUDGET_BYTES) {
    throw new Error(
      `Initial JavaScript exceeds ${INITIAL_JAVASCRIPT_BUDGET_BYTES.toLocaleString()} byte budget`,
    );
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
