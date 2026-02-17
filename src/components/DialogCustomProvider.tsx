/**
 * Custom provider form for adding OpenAI-compatible providers.
 *
 * Collects: provider ID, name, base URL, API key, models, custom headers.
 * Saves via config.update() + auth.set().
 */

import { ArrowLeft, Loader2, Plus, Trash2 } from "lucide-react";
import { type FormEvent, useCallback, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ModelEntry {
	_key: number;
	id: string;
	name: string;
}

interface HeaderEntry {
	_key: number;
	key: string;
	value: string;
}

const _counter = { value: 1 };
function nextKey() {
	return _counter.value++;
}

interface DialogCustomProviderProps {
	onSaved: () => void;
	onBack: () => void;
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

const PROVIDER_ID_REGEX = /^[a-z0-9][a-z0-9\-_]*$/;

function validate(
	providerId: string,
	name: string,
	baseUrl: string,
	models: ModelEntry[],
): string | null {
	if (!providerId.trim()) return "Provider ID is required";
	if (!PROVIDER_ID_REGEX.test(providerId))
		return "Provider ID must be lowercase alphanumeric with hyphens/underscores";
	if (!name.trim()) return "Display name is required";
	if (!baseUrl.trim()) return "Base URL is required";
	if (!baseUrl.startsWith("http://") && !baseUrl.startsWith("https://"))
		return "Base URL must start with http:// or https://";
	if (models.length === 0) return "At least one model is required";
	for (const m of models) {
		if (!m.id.trim()) return "All model IDs must be filled in";
		if (!m.name.trim()) return "All model names must be filled in";
	}
	// Check duplicate model IDs
	const ids = models.map((m) => m.id.trim());
	if (new Set(ids).size !== ids.length) return "Duplicate model IDs found";
	return null;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function DialogCustomProvider({
	onSaved,
	onBack,
}: DialogCustomProviderProps) {
	const bridge = window.electronAPI?.opencode;

	const [providerId, setProviderId] = useState("");
	const [name, setName] = useState("");
	const [baseUrl, setBaseUrl] = useState("");
	const [apiKey, setApiKey] = useState("");
	const [models, setModels] = useState<ModelEntry[]>([
		{ _key: nextKey(), id: "", name: "" },
	]);
	const [headers, setHeaders] = useState<HeaderEntry[]>([]);
	const [saving, setSaving] = useState(false);
	const [error, setError] = useState<string | null>(null);

	const addModel = () =>
		setModels([...models, { _key: nextKey(), id: "", name: "" }]);
	const removeModel = (idx: number) =>
		setModels(models.filter((_, i) => i !== idx));
	const updateModel = (idx: number, field: "id" | "name", value: string) =>
		setModels(models.map((m, i) => (i === idx ? { ...m, [field]: value } : m)));

	const addHeader = () =>
		setHeaders([...headers, { _key: nextKey(), key: "", value: "" }]);
	const removeHeader = (idx: number) =>
		setHeaders(headers.filter((_, i) => i !== idx));
	const updateHeader = (idx: number, field: "key" | "value", value: string) =>
		setHeaders(
			headers.map((h, i) => (i === idx ? { ...h, [field]: value } : h)),
		);

	const handleSubmit = useCallback(
		async (e: FormEvent) => {
			e.preventDefault();
			if (!bridge) return;

			const validationError = validate(providerId, name, baseUrl, models);
			if (validationError) {
				setError(validationError);
				return;
			}

			setSaving(true);
			setError(null);

			try {
				// Build the models record
				const modelsRecord: Record<string, { name: string }> = {};
				for (const m of models) {
					modelsRecord[m.id.trim()] = { name: m.name.trim() };
				}

				// Build custom headers
				const customHeaders: Record<string, string> = {};
				for (const h of headers) {
					if (h.key.trim()) {
						customHeaders[h.key.trim()] = h.value;
					}
				}

				// Detect {env:VAR_NAME} syntax for API key
				const envMatch = apiKey.match(/^\{env:([^}]+)\}$/);
				const providerConfig: Record<string, unknown> = {
					npm: "@ai-sdk/openai-compatible",
					name: name.trim(),
					options: {
						baseURL: baseUrl.trim(),
						...(Object.keys(customHeaders).length > 0
							? { headers: customHeaders }
							: {}),
					},
					models: modelsRecord,
				};
				if (envMatch) {
					providerConfig.env = [envMatch[1]];
				}

				// Update config to add the custom provider
				await bridge.updateConfig({
					provider: {
						[providerId.trim()]: providerConfig,
					},
				});

				// Set the API key if provided (and not an env reference)
				if (apiKey.trim() && !envMatch) {
					await bridge.connectProvider(providerId.trim(), {
						type: "api",
						key: apiKey.trim(),
					});
				}

				await bridge.disposeInstance();
				onSaved();
			} catch (err) {
				setError(err instanceof Error ? err.message : "Failed to save");
			} finally {
				setSaving(false);
			}
		},
		[bridge, providerId, name, baseUrl, apiKey, models, headers, onSaved],
	);

	return (
		<form onSubmit={handleSubmit} className="space-y-4">
			{/* Header */}
			<div className="flex items-center gap-3">
				<button
					type="button"
					onClick={onBack}
					className="text-muted-foreground hover:text-foreground transition-colors"
				>
					<ArrowLeft className="size-4" />
				</button>
				<span className="text-sm font-medium">Custom provider</span>
			</div>

			{/* Provider ID */}
			<div className="space-y-1.5">
				<Label htmlFor="custom-id" className="text-xs">
					Provider ID
				</Label>
				<Input
					id="custom-id"
					type="text"
					value={providerId}
					onChange={(e) => setProviderId(e.target.value.toLowerCase())}
					placeholder="my-provider"
					className="font-mono text-sm"
				/>
			</div>

			{/* Display name */}
			<div className="space-y-1.5">
				<Label htmlFor="custom-name" className="text-xs">
					Display name
				</Label>
				<Input
					id="custom-name"
					type="text"
					value={name}
					onChange={(e) => setName(e.target.value)}
					placeholder="My Provider"
					className="text-sm"
				/>
			</div>

			{/* Base URL */}
			<div className="space-y-1.5">
				<Label htmlFor="custom-url" className="text-xs">
					Base URL
				</Label>
				<Input
					id="custom-url"
					type="text"
					value={baseUrl}
					onChange={(e) => setBaseUrl(e.target.value)}
					placeholder="https://api.example.com/v1"
					className="font-mono text-sm"
				/>
			</div>

			{/* API Key */}
			<div className="space-y-1.5">
				<Label htmlFor="custom-key" className="text-xs">
					API Key
				</Label>
				<Input
					id="custom-key"
					type="password"
					value={apiKey}
					onChange={(e) => setApiKey(e.target.value)}
					placeholder="sk-... or {env:MY_API_KEY}"
					className="font-mono text-sm"
				/>
				<p className="text-[10px] text-muted-foreground">
					Use {"{env:VAR_NAME}"} to reference an environment variable.
				</p>
			</div>

			{/* Models */}
			<div className="space-y-2">
				<div className="flex items-center justify-between">
					<Label className="text-xs">Models</Label>
					<Button
						type="button"
						variant="ghost"
						size="sm"
						className="h-6 text-xs"
						onClick={addModel}
					>
						<Plus className="size-3 mr-1" />
						Add
					</Button>
				</div>
				{models.map((model, idx) => (
					<div key={model._key} className="flex gap-2 items-start">
						<Input
							type="text"
							value={model.id}
							onChange={(e) => updateModel(idx, "id", e.target.value)}
							placeholder="model-id"
							className="font-mono text-xs flex-1"
						/>
						<Input
							type="text"
							value={model.name}
							onChange={(e) => updateModel(idx, "name", e.target.value)}
							placeholder="Display Name"
							className="text-xs flex-1"
						/>
						{models.length > 1 && (
							<Button
								type="button"
								variant="ghost"
								size="sm"
								className="h-8 w-8 p-0 shrink-0 text-muted-foreground"
								onClick={() => removeModel(idx)}
							>
								<Trash2 className="size-3" />
							</Button>
						)}
					</div>
				))}
			</div>

			{/* Custom headers (collapsible) */}
			<div className="space-y-2">
				<div className="flex items-center justify-between">
					<Label className="text-xs">
						Custom headers{" "}
						<span className="text-muted-foreground">(optional)</span>
					</Label>
					<Button
						type="button"
						variant="ghost"
						size="sm"
						className="h-6 text-xs"
						onClick={addHeader}
					>
						<Plus className="size-3 mr-1" />
						Add
					</Button>
				</div>
				{headers.map((header, idx) => (
					<div key={header._key} className="flex gap-2 items-start">
						<Input
							type="text"
							value={header.key}
							onChange={(e) => updateHeader(idx, "key", e.target.value)}
							placeholder="Header-Name"
							className="text-xs flex-1"
						/>
						<Input
							type="text"
							value={header.value}
							onChange={(e) => updateHeader(idx, "value", e.target.value)}
							placeholder="value"
							className="text-xs flex-1"
						/>
						<Button
							type="button"
							variant="ghost"
							size="sm"
							className="h-8 w-8 p-0 shrink-0 text-muted-foreground"
							onClick={() => removeHeader(idx)}
						>
							<Trash2 className="size-3" />
						</Button>
					</div>
				))}
			</div>

			{/* Error */}
			{error && <p className="text-xs text-destructive">{error}</p>}

			{/* Submit */}
			<Button type="submit" size="sm" className="w-full" disabled={saving}>
				{saving ? (
					<Loader2 className="size-3.5 animate-spin mr-1.5" />
				) : (
					<Plus className="size-3.5 mr-1.5" />
				)}
				Add custom provider
			</Button>
		</form>
	);
}
