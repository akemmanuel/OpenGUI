/**
 * Renders a provider icon from the SVG assets in ./svgs.
 *
 * Vite builds the asset map from the directory contents, so adding a provider icon
 * only requires adding an SVG file named after the provider ID.
 */

import type { SVGAttributes } from "react";
import { getProviderIconSvg, resolveProviderIcon } from "./types";

type ProviderIconProps = SVGAttributes<SVGSVGElement> & {
  /** Provider ID (matched against SVG file names in ./svgs). */
  provider: string;
};

export function ProviderIcon({ provider, className, ...rest }: ProviderIconProps) {
  const iconId = resolveProviderIcon(provider);
  const iconSvg = getProviderIconSvg(provider);
  const viewBox = iconSvg.match(/\sviewBox=(['"])(.*?)\1/)?.[2] ?? "0 0 24 24";
  const innerSvg = iconSvg.replace(/^\s*<svg\b[^>]*>/i, "").replace(/<\/svg>\s*$/i, "");

  return (
    <svg
      aria-hidden="true"
      data-provider-icon={iconId}
      viewBox={viewBox}
      className={className}
      focusable="false"
      dangerouslySetInnerHTML={{ __html: innerSvg }}
      {...rest}
    />
  );
}
