/**
 * Fetches provider icons from models.dev and generates:
 * 1. Individual SVG files in src/components/provider-icons/svgs/
 * 2. A combined sprite.svg with all icons as <symbol> elements
 * 3. A types.ts file with all valid icon names
 *
 * Usage: bun scripts/fetch-provider-icons.ts
 */

const MODELS_URL = process.env.OPENCODE_MODELS_URL || "https://models.dev";
const ICONS_DIR = "src/components/provider-icons/svgs";
const OUTPUT_DIR = "src/components/provider-icons";

async function main() {
	console.log(`Fetching provider list from ${MODELS_URL}/api.json ...`);
	const apiRes = await fetch(`${MODELS_URL}/api.json`);
	if (!apiRes.ok) {
		throw new Error(`Failed to fetch api.json: ${apiRes.status}`);
	}
	const api = (await apiRes.json()) as Record<string, unknown>;
	const providerIds = Object.keys(api);
	console.log(`Found ${providerIds.length} providers`);

	// Ensure output directories exist
	await Bun.write(`${ICONS_DIR}/.gitkeep`, "");

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
				await Bun.write(`${ICONS_DIR}/${id}.svg`, svg);
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

	console.log(`Downloaded ${succeeded.length} icons, ${failed.length} failed`);
	if (failed.length > 0) {
		console.log(`Failed: ${failed.join(", ")}`);
	}

	// Sort for deterministic output
	succeeded.sort();

	// Generate sprite.svg
	console.log("Generating sprite.svg ...");
	const symbols: string[] = [];

	for (const id of succeeded) {
		const svgContent = await Bun.file(`${ICONS_DIR}/${id}.svg`).text();

		// Extract the viewBox from the SVG, default to "0 0 40 40"
		const viewBoxMatch = svgContent.match(/viewBox="([^"]+)"/);
		const viewBox = viewBoxMatch?.[1] ?? "0 0 40 40";

		// Extract inner content (everything between <svg> and </svg>)
		const innerMatch = svgContent.match(/<svg[^>]*>([\s\S]*?)<\/svg>/);
		const inner = innerMatch?.[1]?.trim() ?? "";

		if (inner) {
			symbols.push(
				`  <symbol viewBox="${viewBox}" id="${id}">${inner}</symbol>`,
			);
		}
	}

	const sprite = `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink">
<defs>
${symbols.join("\n")}
</defs>
</svg>`;

	await Bun.write(`${OUTPUT_DIR}/sprite.svg`, sprite);
	console.log(`Wrote sprite.svg with ${symbols.length} symbols`);

	// Generate types.ts
	console.log("Generating types.ts ...");
	const typesContent = `/**
 * Auto-generated provider icon names.
 * Do not edit manually - run \`bun scripts/fetch-provider-icons.ts\` to regenerate.
 */

export const providerIconNames = [
${succeeded.map((id) => `  "${id}",`).join("\n")}
] as const;

export type ProviderIconName = (typeof providerIconNames)[number];
`;

	await Bun.write(`${OUTPUT_DIR}/types.ts`, typesContent);
	console.log(`Wrote types.ts with ${succeeded.length} icon names`);

	console.log("Done!");
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
