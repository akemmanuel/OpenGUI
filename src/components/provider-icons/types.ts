/**
 * Provider icon asset manifest.
 *
 * Vite expands this glob at build time, so adding an icon only requires dropping an
 * SVG into ./svgs. No provider-name list or sprite sheet updates are needed for
 * the React component to resolve it.
 */

const iconModules = import.meta.glob("./svgs/*.svg", {
  eager: true,
  query: "?url",
  import: "default",
}) as Record<string, string>;

const rawIconModules = import.meta.glob("./svgs/*.svg", {
  eager: true,
  query: "?raw",
  import: "default",
}) as Record<string, string>;

const iconNameFromPath = (path: string) => path.match(/\/([^/]+)\.svg$/)?.[1] ?? path;

const providerIconUrls = Object.fromEntries(
  Object.entries(iconModules)
    .map(([path, url]) => [iconNameFromPath(path), url] as const)
    .sort(([left], [right]) => left.localeCompare(right)),
) as Readonly<Record<string, string>>;

const providerIconSvgs = Object.fromEntries(
  Object.entries(rawIconModules)
    .map(([path, svg]) => [iconNameFromPath(path), svg] as const)
    .sort(([left], [right]) => left.localeCompare(right)),
) as Readonly<Record<string, string>>;

export type ProviderIconName = string;

const fallbackProviderIcon = "synthetic";

/** pi provider and connection ids whose icon is filed under another name. */
const providerIconAliases: Readonly<Record<string, string>> = {
  "chatgpt-codex": "openai",
  "openai-codex": "openai",
  fireworks: "fireworks-ai",
  together: "togetherai",
  "kimi-coding": "kimi-for-coding",
  "vercel-ai-gateway": "vercel",
  "zai-coding-cn": "zai-coding-plan",
  "qwen-token-plan": "alibaba",
  "qwen-token-plan-cn": "alibaba-cn",
  "qwen-token-plan-individual": "alibaba",
  "xiaomi-token-plan-ams": "xiaomi",
  "xiaomi-token-plan-cn": "xiaomi",
  "xiaomi-token-plan-sgp": "xiaomi",
};

export function resolveProviderIcon(id: string): ProviderIconName {
  const name = providerIconAliases[id] ?? id;
  return providerIconUrls[name] ? name : fallbackProviderIcon;
}

export function getProviderIconSvg(id: string): string {
  return providerIconSvgs[resolveProviderIcon(id)] ?? "";
}
