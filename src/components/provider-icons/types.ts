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

export const providerIconUrls = Object.fromEntries(
  Object.entries(iconModules)
    .map(([path, url]) => [iconNameFromPath(path), url] as const)
    .sort(([left], [right]) => left.localeCompare(right)),
) as Readonly<Record<string, string>>;

export const providerIconSvgs = Object.fromEntries(
  Object.entries(rawIconModules)
    .map(([path, svg]) => [iconNameFromPath(path), svg] as const)
    .sort(([left], [right]) => left.localeCompare(right)),
) as Readonly<Record<string, string>>;

export type ProviderIconName = string;

export const providerIconNames = Object.keys(providerIconUrls) as readonly ProviderIconName[];

const fallbackProviderIcon = "synthetic";

export function resolveProviderIcon(id: string): ProviderIconName {
  return providerIconUrls[id] ? id : fallbackProviderIcon;
}

export function getProviderIconUrl(id: string): string {
  return providerIconUrls[resolveProviderIcon(id)] ?? "";
}

export function getProviderIconSvg(id: string): string {
  return providerIconSvgs[resolveProviderIcon(id)] ?? "";
}
