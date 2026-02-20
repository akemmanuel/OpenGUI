import type {
	Agent,
	Message,
	Part,
	Provider,
} from "@opencode-ai/sdk/v2/client";
import { type MutableRefObject, useCallback } from "react";
import { findModel } from "@/lib/utils";
import type { OpenCodeBridge, SelectedModel } from "@/types/electron";
import type { MessageEntry, Session, SessionColor } from "../use-opencode";
import type { VariantSelections } from "./use-variant";
import { variantKey } from "./use-variant";

type DispatchAction =
	| { type: "SET_SESSIONS"; payload: Session[] }
	| { type: "SET_ACTIVE_SESSION"; payload: string | null }
	| { type: "SET_MESSAGES"; payload: MessageEntry[] }
	| { type: "LOAD_CHILD_SESSION"; payload: LoadChildSessionPayload }
	| { type: "SET_SELECTED_MODEL"; payload: SelectedModel | null }
	| { type: "SET_SELECTED_AGENT"; payload: string | null }
	| { type: "SET_VARIANT_SELECTIONS"; payload: VariantSelections }
	| { type: "SET_ERROR"; payload: string | null }
	| { type: "SESSION_DELETED"; payload: string }
	| { type: "CLEAR_DRAFT_SESSION" }
	| { type: "START_DRAFT_SESSION"; payload: string }
	| { type: "SET_DRAFT_TEMPORARY"; payload: boolean }
	| { type: "SESSION_UPDATED"; payload: Session }
	| {
			type: "SET_SESSION_META";
			payload: { sessionId: string; meta: SessionMeta };
	  }
	| {
			type: "REGISTER_WORKTREE";
			payload: { worktreeDir: string; parentDir: string };
	  }
	| { type: "UNREGISTER_WORKTREE"; payload: string };

type SessionMeta = { color?: SessionColor; tags?: string[] };

interface LoadChildSessionPayload {
	childSessionId: string;
	messages: Array<{ info: Message; parts: Part[] }>;
}

interface UseSessionsParams {
	bridge: OpenCodeBridge | undefined;
	dispatch: (action: DispatchAction) => void;
	state: {
		sessions: Session[];
		activeSessionId: string | null;
		busySessionIds: Set<string>;
	};
	providersRef: MutableRefObject<Provider[]>;
	agentsRef: MutableRefObject<Agent[]>;
	variantSelectionsRef: MutableRefObject<VariantSelections>;
	selectSessionRequestRef: MutableRefObject<number>;
	temporarySessionsRef: MutableRefObject<Set<string>>;
	activeSessionIdRef: MutableRefObject<string | null>;
}

function extractModelFromMessages(
	messages: MessageEntry[],
	providers: Provider[],
): SelectedModel | null {
	for (let i = messages.length - 1; i >= 0; i--) {
		const msg = messages[i]?.info;
		if (
			msg?.role === "assistant" &&
			"providerID" in msg &&
			"modelID" in msg &&
			msg.providerID &&
			msg.modelID
		) {
			const candidate: SelectedModel = {
				providerID: msg.providerID,
				modelID: msg.modelID,
			};
			if (findModel(providers, candidate.providerID, candidate.modelID)) {
				return candidate;
			}
		}
	}
	return null;
}

function extractAgentFromMessages(
	messages: MessageEntry[],
	agents: Agent[],
): string | null {
	for (let i = messages.length - 1; i >= 0; i--) {
		const msg = messages[i]?.info;
		if (msg?.role === "assistant" && "agent" in msg && msg.agent) {
			const exists = agents.some(
				(a) =>
					a.name === msg.agent &&
					(a.mode === "primary" || a.mode === "all") &&
					!a.hidden,
			);
			if (exists) {
				return msg.agent === "build" ? null : msg.agent;
			}
		}
	}
	return null;
}

function extractVariantFromMessages(
	messages: MessageEntry[],
): string | undefined {
	for (let i = messages.length - 1; i >= 0; i--) {
		const msg = messages[i]?.info;
		if (msg?.role === "assistant" && "variant" in msg && msg.variant) {
			return msg.variant as string;
		}
	}
	return undefined;
}

export function useSessions({
	bridge,
	dispatch,
	state,
	providersRef,
	agentsRef,
	variantSelectionsRef,
	selectSessionRequestRef,
	temporarySessionsRef,
	activeSessionIdRef,
}: UseSessionsParams) {
	const refreshSessions = useCallback(async () => {
		if (!bridge) return;
		const res = await bridge.listSessions();
		if (res.success && res.data) {
			dispatch({ type: "SET_SESSIONS", payload: res.data as Session[] });
		}
	}, [bridge, dispatch]);

	const selectSession = useCallback(
		async (id: string | null) => {
			const prevId = activeSessionIdRef.current;
			if (prevId && prevId !== id && temporarySessionsRef.current.has(prevId)) {
				dispatch({ type: "SESSION_DELETED", payload: prevId });
				bridge?.deleteSession(prevId).catch(() => {
					/* best effort */
				});
			}

			const requestId = ++selectSessionRequestRef.current;
			dispatch({ type: "SET_ACTIVE_SESSION", payload: id });
			if (!id || !bridge) return;
			const res = await bridge.getMessages(id);
			if (requestId !== selectSessionRequestRef.current) return;
			const messages = res.success && res.data ? res.data : [];
			dispatch({ type: "SET_MESSAGES", payload: messages });

			if (messages.length > 0) {
				const childSessionIds = new Set<string>();
				for (const msg of messages) {
					for (const part of msg.parts) {
						if (part.type !== "tool") continue;
						if (part.tool.toLowerCase() !== "task") continue;
						const meta =
							"metadata" in part.state && part.state.metadata
								? (part.state.metadata as Record<string, unknown>)
								: null;
						if (meta && typeof meta.sessionId === "string") {
							childSessionIds.add(meta.sessionId);
						}
					}
				}

				for (const childSid of childSessionIds) {
					bridge.getMessages(childSid).then((childRes) => {
						if (requestId !== selectSessionRequestRef.current) return;
						if (childRes.success && childRes.data) {
							dispatch({
								type: "LOAD_CHILD_SESSION",
								payload: {
									childSessionId: childSid,
									messages: childRes.data,
								},
							});
						}
					});
				}
			}

			if (messages.length > 0) {
				const sessionModel = extractModelFromMessages(
					messages,
					providersRef.current,
				);
				if (sessionModel) {
					dispatch({ type: "SET_SELECTED_MODEL", payload: sessionModel });
				}

				const sessionAgent = extractAgentFromMessages(
					messages,
					agentsRef.current,
				);
				dispatch({ type: "SET_SELECTED_AGENT", payload: sessionAgent });

				if (sessionModel) {
					const sessionVariant = extractVariantFromMessages(messages);
					const key = variantKey(sessionModel.providerID, sessionModel.modelID);
					const newSelections = { ...variantSelectionsRef.current };
					if (sessionVariant) {
						newSelections[key] = sessionVariant;
					} else {
						delete newSelections[key];
					}
					dispatch({
						type: "SET_VARIANT_SELECTIONS",
						payload: newSelections,
					});
				}
			} else {
				dispatch({ type: "SET_SELECTED_AGENT", payload: null });
			}
		},
		[
			bridge,
			dispatch,
			providersRef,
			agentsRef,
			variantSelectionsRef,
			selectSessionRequestRef,
			temporarySessionsRef,
			activeSessionIdRef,
		],
	);

	const createSession = useCallback(
		async (title?: string, directory?: string): Promise<Session | null> => {
			if (!bridge) return null;
			const res = await bridge.createSession(title, directory);
			if (res.success && res.data) {
				await selectSession(res.data.id);
				return res.data as Session;
			}
			dispatch({
				type: "SET_ERROR",
				payload: res.error ?? "Failed to create session",
			});
			return null;
		},
		[bridge, dispatch, selectSession],
	);

	const deleteSession = useCallback(
		async (id: string) => {
			if (!bridge) return;
			if (state.activeSessionId === id) {
				const idx = state.sessions.findIndex((s) => s.id === id);
				const next = state.sessions[idx + 1] ?? state.sessions[idx - 1] ?? null;
				if (next) {
					selectSession(next.id);
				}
			}
			dispatch({ type: "SESSION_DELETED", payload: id });
			bridge.deleteSession(id).catch(() => {
				/* best effort */
			});
		},
		[bridge, dispatch, state.activeSessionId, state.sessions, selectSession],
	);

	const renameSession = useCallback(
		async (id: string, title: string) => {
			if (!bridge) return;
			const trimmed = title.trim();
			if (!trimmed) return;
			bridge.updateSession(id, trimmed).catch(() => {
				/* best effort */
			});
		},
		[bridge],
	);

	const startDraftSession = useCallback(
		(directory: string) => {
			const prevId = activeSessionIdRef.current;
			if (prevId && temporarySessionsRef.current.has(prevId)) {
				dispatch({ type: "SESSION_DELETED", payload: prevId });
				bridge?.deleteSession(prevId);
			}
			dispatch({ type: "START_DRAFT_SESSION", payload: directory });
			dispatch({ type: "SET_SELECTED_AGENT", payload: null });
		},
		[bridge, dispatch, activeSessionIdRef, temporarySessionsRef],
	);

	const setDraftTemporary = useCallback(
		(temporary: boolean) => {
			dispatch({ type: "SET_DRAFT_TEMPORARY", payload: temporary });
		},
		[dispatch],
	);

	const revertToMessage = useCallback(
		async (messageID: string) => {
			if (!bridge || !state.activeSessionId) return;
			if (state.busySessionIds.has(state.activeSessionId)) {
				await bridge.abort(state.activeSessionId);
			}
			try {
				const res = await bridge.revertSession(
					state.activeSessionId,
					messageID,
				);
				if (res.success && res.data) {
					dispatch({ type: "SESSION_UPDATED", payload: res.data as Session });
				}
				const msgRes = await bridge.getMessages(state.activeSessionId);
				if (msgRes.success && msgRes.data) {
					dispatch({ type: "SET_MESSAGES", payload: msgRes.data });
				}
			} catch (err) {
				dispatch({
					type: "SET_ERROR",
					payload:
						err instanceof Error ? err.message : "Failed to revert session",
				});
			}
		},
		[bridge, dispatch, state.activeSessionId, state.busySessionIds],
	);

	const unrevert = useCallback(async () => {
		if (!bridge || !state.activeSessionId) return;
		try {
			const res = await bridge.unrevertSession(state.activeSessionId);
			if (res.success && res.data) {
				dispatch({ type: "SESSION_UPDATED", payload: res.data as Session });
			}
			const msgRes = await bridge.getMessages(state.activeSessionId);
			if (msgRes.success && msgRes.data) {
				dispatch({ type: "SET_MESSAGES", payload: msgRes.data });
			}
		} catch (err) {
			dispatch({
				type: "SET_ERROR",
				payload:
					err instanceof Error ? err.message : "Failed to unrevert session",
			});
		}
	}, [bridge, dispatch, state.activeSessionId]);

	const forkFromMessage = useCallback(
		async (messageID: string) => {
			if (!bridge || !state.activeSessionId) return;
			try {
				const res = await bridge.forkSession(state.activeSessionId, messageID);
				if (res.success && res.data) {
					await selectSession(res.data.id);
				}
			} catch (err) {
				dispatch({
					type: "SET_ERROR",
					payload:
						err instanceof Error ? err.message : "Failed to fork session",
				});
			}
		},
		[bridge, dispatch, state.activeSessionId, selectSession],
	);

	const setSessionColor = useCallback(
		(sessionId: string, color: SessionColor) => {
			dispatch({
				type: "SET_SESSION_META",
				payload: { sessionId, meta: { color } },
			});
		},
		[dispatch],
	);

	const setSessionTags = useCallback(
		(sessionId: string, tags: string[]) => {
			dispatch({
				type: "SET_SESSION_META",
				payload: { sessionId, meta: { tags } },
			});
		},
		[dispatch],
	);

	const registerWorktree = useCallback(
		(worktreeDir: string, parentDir: string) => {
			dispatch({
				type: "REGISTER_WORKTREE",
				payload: { worktreeDir, parentDir },
			});
		},
		[dispatch],
	);

	const unregisterWorktree = useCallback(
		(worktreeDir: string) => {
			dispatch({ type: "UNREGISTER_WORKTREE", payload: worktreeDir });
		},
		[dispatch],
	);

	return {
		refreshSessions,
		selectSession,
		createSession,
		deleteSession,
		renameSession,
		startDraftSession,
		setDraftTemporary,
		revertToMessage,
		unrevert,
		forkFromMessage,
		setSessionColor,
		setSessionTags,
		registerWorktree,
		unregisterWorktree,
	};
}
