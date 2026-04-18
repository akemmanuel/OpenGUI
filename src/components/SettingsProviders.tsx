/**
 * Provider management section for the Settings dialog.
 *
 * Shows three areas:
 * 1. Connected providers (with disconnect)
 * 2. Popular providers (quick connect)
 * 3. Custom provider + "View all" link
 */

import { Loader2, Plus, Unplug } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { DialogConnectProvider } from "@/components/DialogConnectProvider";
import { DialogCustomProvider } from "@/components/DialogCustomProvider";
import { DialogSelectProvider } from "@/components/DialogSelectProvider";
import { ProviderIcon } from "@/components/provider-icons/ProviderIcon";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { useActions, useConnectionState } from "@/hooks/use-opencode";
import { POPULAR_PROVIDER_IDS } from "@/lib/constants";
import type { AllProvidersData, ProviderAuthMethod } from "@/types/electron";

// ---------------------------------------------------------------------------
// Source badge
// ---------------------------------------------------------------------------

function SourceBadge({ source }: { source: string }) {
	if (source === "custom") {
		return (
			<Badge variant="outline" className="text-[10px] px-1.5 py-0">
				custom
			</Badge>
		);
	}
	if (source === "env" || source === "api" || source === "config") {
		return (
			<Badge variant="secondary" className="text-[10px] px-1.5 py-0">
				{source === "api" ? "api key" : source}
			</Badge>
		);
	}
	return null;
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export function SettingsProviders() {
	const { refreshProviders } = useActions();
	const { activeDirectory } = useConnectionState();
	const bridge = window.electronAPI?.opencode;
	const scopedDirectory = activeDirectory ?? undefined;

	// Data
	const [allProviders, setAllProviders] = useState<AllProvidersData | null>(
		null,
	);
	const [authMethods, setAuthMethods] = useState<
		Record<string, ProviderAuthMethod[]>
	>({});
	const [loading, setLoading] = useState(true);
	const [disconnecting, setDisconnecting] = useState<string | null>(null);

	// Sub-dialog state
	const [connectProviderID, setConnectProviderID] = useState<string | null>(
		null,
	);
	const [showCustom, setShowCustom] = useState(false);
	const [showSelectAll, setShowSelectAll] = useState(false);

	// Wait for auth methods to be loaded for this provider
	const isAuthLoading =
		loading ||
		(!connectProviderID ? false : authMethods[connectProviderID] === undefined);

	const refresh = useCallback(async () => {
		if (!bridge) return;
		const [provRes, authRes] = await Promise.all([
			bridge.listAllProviders(scopedDirectory),
			bridge.getProviderAuthMethods(scopedDirectory),
		]);
		if (provRes.success && provRes.data) {
			setAllProviders(provRes.data);
		}
		if (authRes.success && authRes.data) {
			setAuthMethods(authRes.data);
		}
		setLoading(false);
	}, [bridge, scopedDirectory]);

	useEffect(() => {
		void refresh();
	}, [refresh]);

	const handleDisconnect = async (providerID: string) => {
		if (!bridge) return;
		setDisconnecting(providerID);
		try {
			await bridge.disconnectProvider(scopedDirectory, providerID);
			await bridge.disposeInstance(scopedDirectory);
			await refresh();
			await refreshProviders();
		} finally {
			setDisconnecting(null);
		}
	};

	const handleConnected = async () => {
		// Called after a provider is connected (from any sub-dialog)
		setConnectProviderID(null);
		setShowCustom(false);
		setShowSelectAll(false);
		await refresh();
		await refreshProviders();
	};

	if (loading) {
		return (
			<div className="flex items-center justify-center py-8">
				<Spinner className="size-5" />
			</div>
		);
	}

	if (!allProviders) {
		return (
			<div className="text-center py-6 text-sm text-muted-foreground">
				Could not load providers. Is the server connected?
			</div>
		);
	}

	const connectedSet = new Set(allProviders.connected);
	const connectedProviders = allProviders.all.filter((p) =>
		connectedSet.has(p.id),
	);
	const popularNotConnected = POPULAR_PROVIDER_IDS.filter(
		(id) => !connectedSet.has(id),
	);
	// For popular providers that aren't in the `all` list (not yet fetched from server),
	// create a minimal entry
	const allById = new Map(allProviders.all.map((p) => [p.id, p]));

	// If a connect dialog is open, show it instead
	if (connectProviderID) {
		const provider = allById.get(connectProviderID);
		return (
			<DialogConnectProvider
				directory={scopedDirectory}
				providerID={connectProviderID}
				providerName={provider?.name ?? connectProviderID}
				authMethods={authMethods[connectProviderID] ?? []}
				loading={isAuthLoading}
				onConnected={handleConnected}
				onBack={() => setConnectProviderID(null)}
			/>
		);
	}

	if (showCustom) {
		return (
			<DialogCustomProvider
				directory={scopedDirectory}
				onSaved={handleConnected}
				onBack={() => setShowCustom(false)}
			/>
		);
	}

	if (showSelectAll) {
		return (
			<DialogSelectProvider
				providers={allProviders.all}
				connectedIds={connectedSet}
				onSelect={(id: string) => {
					setShowSelectAll(false);
					setConnectProviderID(id);
				}}
				onCustom={() => {
					setShowSelectAll(false);
					setShowCustom(true);
				}}
				onBack={() => setShowSelectAll(false)}
			/>
		);
	}

	return (
		<div className="space-y-5 max-h-[50vh] overflow-y-auto pr-1">
			{/* Connected providers */}
			{connectedProviders.length > 0 && (
				<section className="space-y-2">
					<h4 className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
						Connected
					</h4>
					{connectedProviders.map((provider) => {
						const isEnv = provider.source === "env";
						const isDisconnecting = disconnecting === provider.id;
						return (
							<div
								key={provider.id}
								className="flex items-center gap-3 rounded-lg border p-3 bg-card"
							>
								<ProviderIcon
									provider={provider.id}
									className="size-5 shrink-0"
								/>
								<div className="flex-1 min-w-0">
									<div className="flex items-center gap-2">
										<span className="text-sm font-medium truncate">
											{provider.name || provider.id}
										</span>
										<SourceBadge source={provider.source} />
									</div>
								</div>
								{isEnv ? (
									<span
										className="text-[11px] text-muted-foreground shrink-0"
										title="Connected from your environment variables"
									>
										from env
									</span>
								) : (
									<Button
										variant="ghost"
										size="sm"
										className="text-destructive shrink-0"
										disabled={isDisconnecting}
										onClick={() => handleDisconnect(provider.id)}
									>
										{isDisconnecting ? (
											<Loader2 className="size-3.5 animate-spin" />
										) : (
											<Unplug className="size-3.5" />
										)}
										<span className="ml-1.5">Disconnect</span>
									</Button>
								)}
							</div>
						);
					})}
				</section>
			)}

			{/* Popular providers (not yet connected) */}
			{popularNotConnected.length > 0 && (
				<section className="space-y-2">
					<h4 className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
						Popular
					</h4>
					{popularNotConnected.map((id) => {
						const provider = allById.get(id);
						return (
							<div
								key={id}
								className="flex items-center gap-3 rounded-lg border p-3 bg-card"
							>
								<ProviderIcon provider={id} className="size-5 shrink-0" />
								<span className="text-sm font-medium truncate flex-1">
									{provider?.name || id}
								</span>
								<Button
									variant="outline"
									size="sm"
									onClick={() => setConnectProviderID(id)}
								>
									<Plus className="size-3.5 mr-1" />
									Connect
								</Button>
							</div>
						);
					})}
				</section>
			)}

			{/* Custom + View all */}
			<section className="space-y-2">
				<h4 className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
					Other
				</h4>
				<div className="flex items-center gap-3 rounded-lg border p-3 bg-card">
					<ProviderIcon provider="synthetic" className="size-5 shrink-0" />
					<span className="text-sm font-medium truncate flex-1">
						Custom provider
					</span>
					<Button
						variant="outline"
						size="sm"
						onClick={() => setShowCustom(true)}
					>
						<Plus className="size-3.5 mr-1" />
						Connect
					</Button>
				</div>
				<button
					type="button"
					className="text-xs text-muted-foreground hover:text-foreground transition-colors underline underline-offset-2"
					onClick={() => setShowSelectAll(true)}
				>
					View all providers
				</button>
			</section>
		</div>
	);
}
