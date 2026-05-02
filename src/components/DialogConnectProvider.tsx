/**
 * Connect-provider sub-view shown inside the Settings dialog.
 *
 * Handles two auth flows:
 * - API key: simple text input
 * - OAuth: opens a URL, user enters a code or auto-polls
 */

import { Check, ExternalLink, Key, Loader2, ShieldCheck } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { ProviderIcon } from "@/components/provider-icons/ProviderIcon";
import { SubDialogHeader } from "@/components/SubDialogHeader";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type { AgentBackendId } from "@/agents";
import { useAgentBackend } from "@/hooks/use-agent-backend";
import { useConnectionState } from "@/hooks/use-agent-state";
import { getErrorMessage, openExternalLink } from "@/lib/utils";
import type {
	ProviderAuthMethod,
	ProviderOAuthAuthorization,
} from "@/types/electron";

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

interface DialogConnectProviderProps {
	directory?: string;
	backendId?: AgentBackendId;
	providerID: string;
	providerName: string;
	authMethods: ProviderAuthMethod[];
	loading?: boolean;
	onConnected: () => void;
	onBack: () => void;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function DialogConnectProvider({
	directory,
	backendId,
	providerID,
	providerName,
	authMethods,
	loading = false,
	onConnected,
	onBack,
}: DialogConnectProviderProps) {
	const backend = useAgentBackend(backendId);
	const providersApi = backend?.platform?.providers;
	const { activeWorkspaceId } = useConnectionState();

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
	const pollingTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
	const connectedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

	// Clear pending timers on unmount
	useEffect(() => {
		return () => {
			if (pollingTimerRef.current !== null) {
				clearTimeout(pollingTimerRef.current);
				pollingTimerRef.current = null;
			}
			if (connectedTimerRef.current !== null) {
				clearTimeout(connectedTimerRef.current);
				connectedTimerRef.current = null;
			}
		};
	}, []);

	const scheduleConnected = useCallback(() => {
		if (connectedTimerRef.current !== null) {
			clearTimeout(connectedTimerRef.current);
		}
		connectedTimerRef.current = setTimeout(() => {
			connectedTimerRef.current = null;
			onConnected();
		}, 600);
	}, [onConnected]);

	const handleApiKeyConnect = useCallback(async () => {
		if (!providersApi || !apiKey.trim()) return;
		setConnecting(true);
		setError(null);
		try {
			const target = { directory, workspaceId: activeWorkspaceId };
			await providersApi.connect(target, providerID, {
				type: "api",
				key: apiKey.trim(),
			});
			await providersApi.dispose(target);
			setSuccess(true);
			scheduleConnected();
		} catch (err) {
			setError(getErrorMessage(err));
		} finally {
			setConnecting(false);
		}
	}, [providersApi, directory, activeWorkspaceId, providerID, apiKey, scheduleConnected]);

	const pollOAuth = useCallback(
		async (methodIndex?: number) => {
			if (!providersApi) return;
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
					const target = { directory, workspaceId: activeWorkspaceId };
					const done = await providersApi.oauthCallback(
						target,
						providerID,
						methodIndex,
					);
					if (done) {
						pollingRef.current = false;
						setOauthPolling(false);
						await providersApi.dispose(target);
						setSuccess(true);
						scheduleConnected();
						return;
					}
				} catch {
					// Not ready yet, keep polling
				}
				pollingTimerRef.current = setTimeout(poll, 2000);
			};
			void poll();
		},
		[providersApi, directory, activeWorkspaceId, providerID, scheduleConnected],
	);

	const startOAuth = useCallback(
		async (methodIndex?: number) => {
			if (!providersApi) return;
			setConnecting(true);
			setError(null);
			try {
				const auth = await providersApi.oauthAuthorize(
					{ directory, workspaceId: activeWorkspaceId },
					providerID,
					methodIndex,
				);
				setOauthData(auth);
				if (auth.method === "auto") {
					// Start polling
					setOauthPolling(true);
					pollingRef.current = true;
					void pollOAuth(methodIndex);
				}
			} catch (err) {
				setError(getErrorMessage(err));
			} finally {
				setConnecting(false);
			}
		},
		[providersApi, directory, activeWorkspaceId, providerID, pollOAuth],
	);

	const handleOAuthCode = useCallback(async () => {
		if (!providersApi || !oauthCode.trim()) return;
		setConnecting(true);
		setError(null);
		try {
			const target = { directory, workspaceId: activeWorkspaceId };
			const done = await providersApi.oauthCallback(
				target,
				providerID,
				undefined,
				oauthCode.trim(),
			);
			if (done) {
				await providersApi.dispose(target);
				setSuccess(true);
				scheduleConnected();
			} else {
				setError("Invalid code");
			}
		} catch (err) {
			setError(getErrorMessage(err));
		} finally {
			setConnecting(false);
		}
	}, [providersApi, directory, activeWorkspaceId, providerID, oauthCode, scheduleConnected]);

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
			void startOAuth(idx >= 0 ? idx : undefined);
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

	// Loading state
	if (loading) {
		return (
			<div className="space-y-4">
				<SubDialogHeader onBack={onBack}>
					<ProviderIcon provider={providerID} className="size-5" />
					<span className="text-sm font-medium">{providerName}</span>
				</SubDialogHeader>
				<div className="flex flex-col items-center justify-center py-8 gap-3">
					<Loader2 className="size-5 animate-spin text-muted-foreground" />
					<p className="text-sm text-muted-foreground">Loading...</p>
				</div>
			</div>
		);
	}

	return (
		<div className="space-y-4">
			{/* Header */}
			<SubDialogHeader onBack={onBack}>
				<ProviderIcon provider={providerID} className="size-5" />
				<span className="text-sm font-medium">{providerName}</span>
			</SubDialogHeader>

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
									void startOAuth(idx);
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
								if (e.key === "Enter") void handleApiKeyConnect();
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
							openExternalLink(oauthData.url);
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
									if (e.key === "Enter") void handleOAuthCode();
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
