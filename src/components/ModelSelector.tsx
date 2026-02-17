/**
 * Model selector dialog.
 * Adds searchable model picking with recent selections.
 */

import { BrainCircuit, Check, Lightbulb, Search, Star } from "lucide-react";
import { type KeyboardEventHandler, useEffect, useMemo, useState } from "react";
import { ProviderIcon } from "@/components/provider-icons";
import { Button } from "@/components/ui/button";
import {
	Dialog,
	DialogContent,
	DialogHeader,
	DialogTitle,
	DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import {
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from "@/components/ui/tooltip";
import { useOpenCode } from "@/hooks/use-opencode";
import { cn } from "@/lib/utils";

const RECENT_MODELS_STORAGE_KEY = "opencode:recentModels";
const FAVORITE_MODELS_STORAGE_KEY = "opencode:favoriteModels";
const MAX_RECENT_MODELS = 8;

type ModelOption = {
	value: string;
	providerID: string;
	modelID: string;
	providerName: string;
	label: string;
	reasoning: boolean;
	search: string;
};

function normalize(text: string) {
	return text.trim().toLowerCase();
}

function ModelRow({
	model,
	isSelected,
	isFavorite,
	onSelect,
	onToggleFavorite,
	showProvider,
}: {
	model: ModelOption;
	isSelected: boolean;
	isFavorite: boolean;
	onSelect: (model: ModelOption) => void;
	onToggleFavorite: (value: string) => void;
	showProvider?: boolean;
}) {
	return (
		<div
			className={cn(
				"hover:bg-accent hover:text-accent-foreground group flex w-full items-center justify-between rounded-md px-2 py-1.5 text-left text-xs",
				isSelected && "bg-accent/60 text-foreground",
			)}
		>
			<button
				type="button"
				className="flex min-w-0 flex-1 items-center gap-1.5"
				onClick={() => onSelect(model)}
			>
				{showProvider && (
					<ProviderIcon
						provider={model.providerID}
						className="size-3 shrink-0 text-muted-foreground"
					/>
				)}
				<span className="truncate">{model.label}</span>
				{showProvider && (
					<span className="text-[10px] text-muted-foreground">
						{model.providerName}
					</span>
				)}
				{model.reasoning && (
					<Lightbulb className="size-3 shrink-0 text-amber-500" />
				)}
			</button>
			<span className="flex shrink-0 items-center gap-1">
				{isSelected && <Check className="size-3.5 text-primary" />}
				<button
					type="button"
					onClick={(e) => {
						e.stopPropagation();
						onToggleFavorite(model.value);
					}}
					className={cn(
						"rounded p-0.5",
						isFavorite
							? "text-amber-500"
							: "text-muted-foreground/50 hover:!text-amber-500",
					)}
					title={isFavorite ? "Remove from favorites" : "Add to favorites"}
				>
					<Star className={cn("size-3", isFavorite && "fill-current")} />
				</button>
			</span>
		</div>
	);
}

export function ModelSelector() {
	const { state, setModel } = useOpenCode();
	const { providers, selectedModel } = state;
	const [open, setOpen] = useState(false);
	const [query, setQuery] = useState("");
	const [recentValues, setRecentValues] = useState<string[]>([]);
	const [favoriteValues, setFavoriteValues] = useState<Set<string>>(new Set());

	useEffect(() => {
		if (typeof window === "undefined") return;
		try {
			const stored = localStorage.getItem(RECENT_MODELS_STORAGE_KEY);
			if (stored) {
				const parsed = JSON.parse(stored);
				if (Array.isArray(parsed)) {
					setRecentValues(
						parsed.filter((v): v is string => typeof v === "string"),
					);
				}
			}
		} catch {
			// ignore malformed storage
		}
		try {
			const stored = localStorage.getItem(FAVORITE_MODELS_STORAGE_KEY);
			if (stored) {
				const parsed = JSON.parse(stored);
				if (Array.isArray(parsed)) {
					setFavoriteValues(
						new Set(parsed.filter((v): v is string => typeof v === "string")),
					);
				}
			}
		} catch {
			// ignore malformed storage
		}
	}, []);

	useEffect(() => {
		if (typeof window === "undefined") return;
		try {
			localStorage.setItem(
				RECENT_MODELS_STORAGE_KEY,
				JSON.stringify(recentValues.slice(0, MAX_RECENT_MODELS)),
			);
		} catch {
			// ignore storage errors
		}
	}, [recentValues]);

	useEffect(() => {
		if (typeof window === "undefined") return;
		try {
			localStorage.setItem(
				FAVORITE_MODELS_STORAGE_KEY,
				JSON.stringify([...favoriteValues]),
			);
		} catch {
			// ignore storage errors
		}
	}, [favoriteValues]);

	const groups = useMemo(() => {
		const now = Date.now();
		const eightMonthsMs = 1000 * 60 * 60 * 24 * 30.4375 * 6;
		const alwaysIncludeValues = new Set<string>();
		if (selectedModel) {
			alwaysIncludeValues.add(
				`${selectedModel.providerID}/${selectedModel.modelID}`,
			);
		}
		for (const fav of favoriteValues) {
			alwaysIncludeValues.add(fav);
		}

		return providers
			.filter((provider) => Object.keys(provider.models).length > 0)
			.map((provider) => ({
				id: provider.id,
				name: provider.name,
				models: Object.entries(provider.models)
					.filter(([key, model]) => {
						const value = `${provider.id}/${key}`;
						if (alwaysIncludeValues.has(value)) return true;
						if (model.status === "deprecated") return false;
						const timestamp = Date.parse(model.release_date);
						// Keep models with no valid release date (safe fallback)
						if (!Number.isFinite(timestamp)) return true;
						// Keep models released within the last 8 months
						return Math.abs(now - timestamp) < eightMonthsMs;
					})
					.sort(([, a], [, b]) => a.name.localeCompare(b.name))
					.map(([key, model]) => ({
						value: `${provider.id}/${key}`,
						providerID: provider.id,
						modelID: key,
						providerName: provider.name,
						label: model.name,
						reasoning: model.capabilities.reasoning,
						search: normalize(`${provider.name} ${model.name} ${key}`),
					})),
			}))
			.filter((group) => group.models.length > 0);
	}, [providers, selectedModel, favoriteValues]);

	const allModels = useMemo(
		() => groups.flatMap((group) => group.models),
		[groups],
	);

	const currentValue = selectedModel
		? `${selectedModel.providerID}/${selectedModel.modelID}`
		: null;

	const effectiveCurrentValue = currentValue;

	const currentModel = useMemo(
		() =>
			effectiveCurrentValue
				? allModels.find((model) => model.value === effectiveCurrentValue)
				: null,
		[allModels, effectiveCurrentValue],
	);

	const normalizedQuery = normalize(query);

	const favoriteModels = useMemo(() => {
		const byValue = new Map(allModels.map((model) => [model.value, model]));
		return [...favoriteValues]
			.map((value) => byValue.get(value))
			.filter((model): model is ModelOption => Boolean(model))
			.sort((a, b) => a.label.localeCompare(b.label));
	}, [allModels, favoriteValues]);

	const recentModels = useMemo(() => {
		const byValue = new Map(allModels.map((model) => [model.value, model]));
		return recentValues
			.map((value) => byValue.get(value))
			.filter((model): model is ModelOption => Boolean(model))
			.filter(
				(model) =>
					model.value !== effectiveCurrentValue &&
					!favoriteValues.has(model.value),
			)
			.slice(0, MAX_RECENT_MODELS);
	}, [allModels, effectiveCurrentValue, recentValues, favoriteValues]);

	// Models shown in favorites or recents should not appear in provider groups
	const excludedFromGroups = useMemo(() => {
		const set = new Set<string>();
		for (const m of favoriteModels) set.add(m.value);
		for (const m of recentModels) set.add(m.value);
		return set;
	}, [favoriteModels, recentModels]);

	const filteredGroups = useMemo(() => {
		const base = normalizedQuery
			? groups
			: groups.map((group) => ({
					...group,
					models: group.models.filter(
						(model) => !excludedFromGroups.has(model.value),
					),
				}));
		const filtered = normalizedQuery
			? base.map((group) => ({
					...group,
					models: group.models.filter((model) =>
						model.search.includes(normalizedQuery),
					),
				}))
			: base;
		return filtered.filter((group) => group.models.length > 0);
	}, [groups, normalizedQuery, excludedFromGroups]);

	const firstMatch = useMemo(() => {
		if (!normalizedQuery) return null;
		return filteredGroups[0]?.models[0] ?? null;
	}, [filteredGroups, normalizedQuery]);

	const toggleFavorite = (value: string) => {
		setFavoriteValues((prev) => {
			const next = new Set(prev);
			if (next.has(value)) {
				next.delete(value);
			} else {
				next.add(value);
			}
			return next;
		});
	};

	const selectModel = (model: ModelOption) => {
		setModel({ providerID: model.providerID, modelID: model.modelID });
		setRecentValues((previous) => {
			const next = [model.value, ...previous.filter((v) => v !== model.value)];
			return next.slice(0, MAX_RECENT_MODELS);
		});
		setOpen(false);
	};

	const handleOpenChange = (nextOpen: boolean) => {
		setOpen(nextOpen);
		if (!nextOpen) setQuery("");
	};

	const handleInputKeyDown: KeyboardEventHandler<HTMLInputElement> = (
		event,
	) => {
		if (event.key === "Enter" && firstMatch) {
			event.preventDefault();
			selectModel(firstMatch);
		}
	};

	const hasResults = filteredGroups.some((group) => group.models.length > 0);

	if (providers.length === 0) return null;

	return (
		<Dialog open={open} onOpenChange={handleOpenChange}>
			<Tooltip>
				<TooltipTrigger asChild>
					<DialogTrigger asChild>
						<Button
							type="button"
							variant="ghost"
							size="sm"
							className="!h-7 min-w-0 shrink gap-1.5 px-2 text-xs text-muted-foreground hover:text-foreground"
						>
							{currentModel ? (
								<ProviderIcon
									provider={currentModel.providerID}
									className="size-3.5 shrink-0"
								/>
							) : (
								<BrainCircuit className="size-3.5 shrink-0" />
							)}
							<span className="truncate">
								{currentModel?.label ?? "Select model"}
							</span>
						</Button>
					</DialogTrigger>
				</TooltipTrigger>
				<TooltipContent>Select model</TooltipContent>
			</Tooltip>

			<DialogContent className="p-0 sm:max-w-2xl">
				<DialogHeader className="px-4 pt-4 pb-2">
					<DialogTitle className="text-base">Select model</DialogTitle>
				</DialogHeader>

				<div className="px-4 pb-3">
					<div className="relative">
						<Search className="absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" />
						<Input
							autoFocus
							value={query}
							onChange={(event) => setQuery(event.target.value)}
							onKeyDown={handleInputKeyDown}
							placeholder="Search provider, model, or id..."
							className="h-8 pl-8 text-xs"
						/>
					</div>
				</div>

				<div className="max-h-[60vh] space-y-4 overflow-y-auto px-2 pb-4">
					{!normalizedQuery && favoriteModels.length > 0 && (
						<div className="space-y-1">
							<div className="px-2 text-[11px] font-semibold tracking-wide text-muted-foreground uppercase">
								Favorites
							</div>
							{favoriteModels.map((model) => (
								<ModelRow
									key={`fav-${model.value}`}
									model={model}
									isSelected={model.value === effectiveCurrentValue}
									isFavorite={true}
									onSelect={selectModel}
									onToggleFavorite={toggleFavorite}
									showProvider
								/>
							))}
						</div>
					)}

					{!normalizedQuery && recentModels.length > 0 && (
						<div className="space-y-1">
							<div className="px-2 text-[11px] font-semibold tracking-wide text-muted-foreground uppercase">
								Recent
							</div>
							{recentModels.map((model) => (
								<ModelRow
									key={`recent-${model.value}`}
									model={model}
									isSelected={model.value === effectiveCurrentValue}
									isFavorite={favoriteValues.has(model.value)}
									onSelect={selectModel}
									onToggleFavorite={toggleFavorite}
									showProvider
								/>
							))}
						</div>
					)}

					{hasResults ? (
						filteredGroups.map((group) => (
							<div key={group.id} className="space-y-1">
								<div className="flex items-center gap-1.5 px-2 text-[11px] font-semibold tracking-wide text-muted-foreground uppercase">
									<ProviderIcon
										provider={group.id}
										className="size-3.5 shrink-0"
									/>
									{group.name}
								</div>
								{group.models.map((model) => (
									<ModelRow
										key={model.value}
										model={model}
										isSelected={model.value === effectiveCurrentValue}
										isFavorite={favoriteValues.has(model.value)}
										onSelect={selectModel}
										onToggleFavorite={toggleFavorite}
									/>
								))}
							</div>
						))
					) : (
						<div className="px-2 text-xs text-muted-foreground">
							No models match "{query.trim()}".
						</div>
					)}
				</div>
			</DialogContent>
		</Dialog>
	);
}
