/**
 * Connect-provider sub-view shown inside the Settings dialog.
 *
 * Handles two auth flows:
 * - API key: simple text input
 * - OAuth: opens a URL, user enters a code or auto-polls
 */

import {
	ArrowLeft,
	Check,
	ExternalLink,
	Key,
	Loader2,
	ShieldCheck,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { ProviderIcon } from "@/components/provider-icons/ProviderIcon";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type {
	ProviderAuthMethod,
	ProviderOAuthAuthorization,
} from "@/types/electron";

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

interface DialogConnectProviderProps {
	providerID: string;
	providerName: string;
	authMethods: ProviderAuthMethod[];
	onConnected: () => void;
	onBack: () => void;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function DialogConnectProvider({
	providerID,
	providerName,
	authMethods,
	onConnected,
	onBack,
}: DialogConnectProviderProps) {
	const bridge = window.electronAPI?.opencode;

	// If only one method, auto-select it
	const [selectedMethod, setSelectedMethod] = useState<"api" | "oauth" | null>(
		() => {
			if (authMethods.length === 1 && authMethods[0])
				return authMethods[0].type;
			return null;
		},
	);

	// API key flow
	const [apiKey, setApiKey] = useState("");
	const [connecting, setConnecting] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [success, setSuccess] = useState(false);

	// OAuth flow
	const [oauthData, setOauthData] = useState<ProviderOAuthAuthorization | null>(
		null,
	);
	const [oauthCode, setOauthCode] = useState("");
	const [oauthPolling, setOauthPolling] = useState(false);
	const pollingRef = useRef(false);

	const handleApiKeyConnect = useCallback(async () => {
		if (!bridge || !apiKey.trim()) return;
		setConnecting(true);
		setError(null);
		try {
			const res = await bridge.connectProvider(providerID, {
				type: "api",
				key: apiKey.trim(),
			});
			if (res.success) {
				await bridge.disposeInstance();
				setSuccess(true);
				setTimeout(onConnected, 600);
			} else {
				setError(res.error ?? "Failed to connect");
			}
		} catch (err) {
			setError(err instanceof Error ? err.message : "Unexpected error");
		} finally {
			setConnecting(false);
		}
	}, [bridge, providerID, apiKey, onConnected]);

	const pollOAuth = useCallback(
		async (methodIndex?: number) => {
			if (!bridge) return;
			const maxAttempts = 60; // ~2 minutes at 2s intervals
			let attempts = 0;
			const poll = async () => {
				if (!pollingRef.current || attempts >= maxAttempts) {
					setOauthPolling(false);
					if (attempts >= maxAttempts) {
						setError("OAuth timeout - please try again");
					}
					return;
				}
				attempts++;
				try {
					const res = await bridge.oauthCallback(providerID, methodIndex);
					if (res.success && res.data) {
						pollingRef.current = false;
						setOauthPolling(false);
						await bridge.disposeInstance();
						setSuccess(true);
						setTimeout(onConnected, 600);
						return;
					}
				} catch {
					// Not ready yet, keep polling
				}
				setTimeout(poll, 2000);
			};
			poll();
		},
		[bridge, providerID, onConnected],
	);

	const startOAuth = useCallback(
		async (methodIndex?: number) => {
			if (!bridge) return;
			setConnecting(true);
			setError(null);
			try {
				const res = await bridge.oauthAuthorize(providerID, methodIndex);
				if (res.success && res.data) {
					setOauthData(res.data);
					if (res.data.method === "auto") {
						// Start polling
						setOauthPolling(true);
						pollingRef.current = true;
						pollOAuth(methodIndex);
					}
				} else {
					setError(res.error ?? "Failed to start OAuth");
				}
			} catch (err) {
				setError(err instanceof Error ? err.message : "Unexpected error");
			} finally {
				setConnecting(false);
			}
		},
		[bridge, providerID, pollOAuth],
	);

	const handleOAuthCode = useCallback(async () => {
		if (!bridge || !oauthCode.trim()) return;
		setConnecting(true);
		setError(null);
		try {
			const res = await bridge.oauthCallback(
				providerID,
				undefined,
				oauthCode.trim(),
			);
			if (res.success && res.data) {
				await bridge.disposeInstance();
				setSuccess(true);
				setTimeout(onConnected, 600);
			} else {
				setError(res.error ?? "Invalid code");
			}
		} catch (err) {
			setError(err instanceof Error ? err.message : "Unexpected error");
		} finally {
			setConnecting(false);
		}
	}, [bridge, providerID, oauthCode, onConnected]);

	// Clean up polling on unmount
	useEffect(() => {
		return () => {
			pollingRef.current = false;
		};
	}, []);

	// Auto-start OAuth if that's the only method
	useEffect(() => {
		if (selectedMethod === "oauth" && !oauthData && authMethods.length === 1) {
			const idx = authMethods.findIndex((m) => m.type === "oauth");
			startOAuth(idx >= 0 ? idx : undefined);
		}
	}, [selectedMethod, oauthData, authMethods, startOAuth]);

	// Success state
	if (success) {
		return (
			<div className="flex flex-col items-center justify-center py-8 gap-3">
				<div className="size-10 rounded-full bg-emerald-500/10 flex items-center justify-center">
					<Check className="size-5 text-emerald-500" />
				</div>
				<p className="text-sm font-medium">{providerName} connected</p>
			</div>
		);
	}

	return (
		<div className="space-y-4">
			{/* Header */}
			<div className="flex items-center gap-3">
				<button
					type="button"
					onClick={onBack}
					className="text-muted-foreground hover:text-foreground transition-colors"
				>
					<ArrowLeft className="size-4" />
				</button>
				<ProviderIcon provider={providerID} className="size-5" />
				<span className="text-sm font-medium">{providerName}</span>
			</div>

			{/* Method selection (when multiple methods) */}
			{!selectedMethod && authMethods.length > 1 && (
				<div className="space-y-2">
					<p className="text-xs text-muted-foreground">
						Choose how to connect:
					</p>
					{authMethods.map((method, idx) => (
						<button
							key={`${method.type}-${idx}`}
							type="button"
							className="w-full flex items-center gap-3 rounded-lg border p-3 bg-card hover:bg-accent transition-colors text-left"
							onClick={() => {
								setSelectedMethod(method.type);
								if (method.type === "oauth") {
									startOAuth(idx);
								}
							}}
						>
							{method.type === "api" ? (
								<Key className="size-4 text-muted-foreground" />
							) : (
								<ShieldCheck className="size-4 text-muted-foreground" />
							)}
							<span className="text-sm">{method.label}</span>
						</button>
					))}
				</div>
			)}

			{/* API key input */}
			{selectedMethod === "api" && (
				<div className="space-y-3">
					<div className="space-y-2">
						<Label htmlFor="api-key-input">API Key</Label>
						<Input
							id="api-key-input"
							type="password"
							value={apiKey}
							onChange={(e) => setApiKey(e.target.value)}
							placeholder="sk-..."
							disabled={connecting}
							className="font-mono text-sm"
							autoFocus
							onKeyDown={(e) => {
								if (e.key === "Enter") handleApiKeyConnect();
							}}
						/>
					</div>
					<Button
						onClick={handleApiKeyConnect}
						disabled={connecting || !apiKey.trim()}
						className="w-full"
						size="sm"
					>
						{connecting ? (
							<Loader2 className="size-3.5 animate-spin mr-1.5" />
						) : (
							<Key className="size-3.5 mr-1.5" />
						)}
						Connect
					</Button>
					{authMethods.length > 1 && (
						<button
							type="button"
							className="text-xs text-muted-foreground hover:text-foreground transition-colors"
							onClick={() => setSelectedMethod(null)}
						>
							Use a different method
						</button>
					)}
				</div>
			)}

			{/* OAuth flow */}
			{selectedMethod === "oauth" && oauthData && (
				<div className="space-y-3">
					{oauthData.instructions && (
						<p className="text-xs text-muted-foreground">
							{oauthData.instructions}
						</p>
					)}

					<Button
						variant="outline"
						size="sm"
						className="w-full"
						onClick={() => {
							// Only allow https:// OAuth URLs to prevent phishing / scheme abuse
							try {
								const parsed = new URL(oauthData.url);
								if (
									parsed.protocol !== "https:" &&
									parsed.protocol !== "http:"
								) {
									return;
								}
							} catch {
								return;
							}
							if (window.electronAPI?.openExternal) {
								window.electronAPI.openExternal(oauthData.url);
							} else {
								window.open(oauthData.url, "_blank");
							}
						}}
					>
						<ExternalLink className="size-3.5 mr-1.5" />
						Open authorization page
					</Button>

					{oauthData.method === "code" && (
						<div className="space-y-2">
							<Label htmlFor="oauth-code">Authorization code</Label>
							<Input
								id="oauth-code"
								type="text"
								value={oauthCode}
								onChange={(e) => setOauthCode(e.target.value)}
								placeholder="Paste the code here"
								disabled={connecting}
								className="font-mono text-sm"
								onKeyDown={(e) => {
									if (e.key === "Enter") handleOAuthCode();
								}}
							/>
							<Button
								onClick={handleOAuthCode}
								disabled={connecting || !oauthCode.trim()}
								className="w-full"
								size="sm"
							>
								{connecting ? (
									<Loader2 className="size-3.5 animate-spin mr-1.5" />
								) : (
									<Check className="size-3.5 mr-1.5" />
								)}
								Submit code
							</Button>
						</div>
					)}

					{oauthData.method === "auto" && oauthPolling && (
						<div className="flex items-center gap-2 text-xs text-muted-foreground">
							<Loader2 className="size-3.5 animate-spin" />
							<span>Waiting for authorization...</span>
						</div>
					)}

					{authMethods.length > 1 && (
						<button
							type="button"
							className="text-xs text-muted-foreground hover:text-foreground transition-colors"
							onClick={() => {
								pollingRef.current = false;
								setOauthPolling(false);
								setOauthData(null);
								setSelectedMethod(null);
							}}
						>
							Use a different method
						</button>
					)}
				</div>
			)}

			{/* OAuth loading (before URL is returned) */}
			{selectedMethod === "oauth" && !oauthData && connecting && (
				<div className="flex items-center justify-center py-6 gap-2 text-sm text-muted-foreground">
					<Loader2 className="size-4 animate-spin" />
					<span>Starting authorization...</span>
				</div>
			)}

			{/* Error */}
			{error && <p className="text-xs text-destructive">{error}</p>}
		</div>
	);
}
