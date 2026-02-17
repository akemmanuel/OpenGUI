/**
 * Renders a provider icon from the SVG sprite sheet.
 *
 * Uses an SVG <use> element to reference symbols by provider ID.
 * Falls back to the "synthetic" icon for unknown providers.
 */

import type { SVGAttributes } from "react";
import sprite from "./sprite.svg";
import { type ProviderIconName, providerIconNames } from "./types";

export type ProviderIconProps = SVGAttributes<SVGSVGElement> & {
	/** Provider ID (must match a key in the sprite sheet). */
	provider: string;
};

const iconNameSet = new Set<string>(providerIconNames);

/** Resolve a provider ID to a valid icon name, falling back to "synthetic". */
export function resolveProviderIcon(id: string): ProviderIconName {
	if (iconNameSet.has(id)) return id as ProviderIconName;
	return "synthetic";
}

export function ProviderIcon({
	provider,
	className,
	...rest
}: ProviderIconProps) {
	const iconId = resolveProviderIcon(provider);
	return (
		<svg
			aria-hidden="true"
			data-provider-icon={iconId}
			className={className}
			{...rest}
		>
			<use href={`${sprite}#${iconId}`} />
		</svg>
	);
}
