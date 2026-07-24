import { common, createStarryNight } from "@wooorm/starry-night";
import { toJsxRuntime } from "hast-util-to-jsx-runtime";
import type { ReactNode } from "react";
import { Fragment, jsx, jsxs } from "react/jsx-runtime";
import onigurumaWasmUrl from "vscode-oniguruma/release/onig.wasm?url";

let starryNightPromise: ReturnType<typeof createStarryNight> | null = null;

function getStarryNight(locationHref: string) {
  starryNightPromise ??= createStarryNight(common, {
    getOnigurumaUrlFetch() {
      return new URL(onigurumaWasmUrl, locationHref);
    },
  });
  return starryNightPromise;
}

export async function highlightCode(
  code: string,
  language: string,
  locationHref: string,
): Promise<ReactNode | null> {
  const starryNight = await getStarryNight(locationHref);
  const scope = starryNight.flagToScope(language);
  if (!scope) return null;
  return toJsxRuntime(starryNight.highlight(code, scope), { Fragment, jsx, jsxs });
}
