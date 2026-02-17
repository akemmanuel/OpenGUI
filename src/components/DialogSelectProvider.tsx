/**
 * Searchable provider selection list.
 *
 * Groups providers into "Popular" and "Other", with a search filter.
 * Clicking a provider fires onSelect; clicking "Custom" fires onCustom.
 */

import type { Provider } from "@opencode-ai/sdk/v2/client";
import { ArrowLeft, Check, Plus, Search } from "lucide-react";
import { useMemo, useState } from "react";
import { ProviderIcon } from "@/components/provider-icons/ProviderIcon";
import { Input } from "@/components/ui/input";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const POPULAR_IDS = new Set([
	"anthropic",
	"openai",
	"google",
	"github-copilot",
	"openrouter",
	"xai",
	"deepseek",
	"groq",
	"mistral",
	"azure",
]);

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

interface DialogSelectProviderProps {
	providers: Provider[];
	connectedIds: Set<string>;
	onSelect: (providerID: string) => void;
	onCustom: () => void;
	onBack: () => void;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function DialogSelectProvider({
	providers,
	connectedIds,
	onSelect,
	onCustom,
	onBack,
}: DialogSelectProviderProps) {
	const [search, setSearch] = useState("");
	const lowerSearch = search.toLowerCase().trim();

	const { popular, other } = useMemo(() => {
		const pop: Provider[] = [];
		const oth: Provider[] = [];
		for (const p of providers) {
			// Skip already connected
			if (connectedIds.has(p.id)) continue;
			// Filter by search
			if (
				lowerSearch &&
				!p.id.toLowerCase().includes(lowerSearch) &&
				!(p.name || "").toLowerCase().includes(lowerSearch)
			) {
				continue;
			}
			if (POPULAR_IDS.has(p.id)) {
				pop.push(p);
			} else {
				oth.push(p);
			}
		}
		// Sort alphabetically within groups
		pop.sort((a, b) => (a.name || a.id).localeCompare(b.name || b.id));
		oth.sort((a, b) => (a.name || a.id).localeCompare(b.name || b.id));
		return { popular: pop, other: oth };
	}, [providers, connectedIds, lowerSearch]);

	return (
		<div className="space-y-3">
			{/* Header */}
			<div className="flex items-center gap-3">
				<button
					type="button"
					onClick={onBack}
					className="text-muted-foreground hover:text-foreground transition-colors"
				>
					<ArrowLeft className="size-4" />
				</button>
				<span className="text-sm font-medium">All providers</span>
			</div>

			{/* Search */}
			<div className="relative">
				<Search className="absolute left-2.5 top-1/2 -translate-y-1/2 size-3.5 text-muted-foreground" />
				<Input
					type="text"
					value={search}
					onChange={(e) => setSearch(e.target.value)}
					placeholder="Search providers..."
					className="pl-8 text-sm"
					autoFocus
				/>
			</div>

			{/* Scrollable list */}
			<div className="max-h-[40vh] overflow-y-auto space-y-4 pr-1">
				{/* Custom provider (always at top) */}
				{(!lowerSearch || "custom".includes(lowerSearch)) && (
					<button
						type="button"
						className="w-full flex items-center gap-3 rounded-lg border p-3 bg-card hover:bg-accent transition-colors text-left"
						onClick={onCustom}
					>
						<ProviderIcon provider="synthetic" className="size-5 shrink-0" />
						<span className="text-sm font-medium flex-1">Custom provider</span>
						<Plus className="size-3.5 text-muted-foreground" />
					</button>
				)}

				{/* Popular */}
				{popular.length > 0 && (
					<section className="space-y-1.5">
						<h4 className="text-[10px] font-medium text-muted-foreground uppercase tracking-wide px-1">
							Popular
						</h4>
						{popular.map((p) => (
							<ProviderRow
								key={p.id}
								provider={p}
								connected={false}
								onSelect={onSelect}
							/>
						))}
					</section>
				)}

				{/* Other */}
				{other.length > 0 && (
					<section className="space-y-1.5">
						<h4 className="text-[10px] font-medium text-muted-foreground uppercase tracking-wide px-1">
							Other
						</h4>
						{other.map((p) => (
							<ProviderRow
								key={p.id}
								provider={p}
								connected={false}
								onSelect={onSelect}
							/>
						))}
					</section>
				)}

				{popular.length === 0 && other.length === 0 && (
					<div className="text-center py-6 text-sm text-muted-foreground">
						No providers found for &quot;{search}&quot;
					</div>
				)}
			</div>
		</div>
	);
}

// ---------------------------------------------------------------------------
// Row
// ---------------------------------------------------------------------------

function ProviderRow({
	provider,
	connected,
	onSelect,
}: {
	provider: Provider;
	connected: boolean;
	onSelect: (id: string) => void;
}) {
	return (
		<button
			type="button"
			className="w-full flex items-center gap-3 rounded-lg border p-2.5 bg-card hover:bg-accent transition-colors text-left"
			onClick={() => onSelect(provider.id)}
			disabled={connected}
		>
			<ProviderIcon provider={provider.id} className="size-4 shrink-0" />
			<span className="text-sm truncate flex-1">
				{provider.name || provider.id}
			</span>
			{connected ? (
				<Check className="size-3.5 text-emerald-500" />
			) : (
				<Plus className="size-3.5 text-muted-foreground" />
			)}
		</button>
	);
}
