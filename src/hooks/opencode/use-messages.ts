import type { Agent, QuestionAnswer } from "@opencode-ai/sdk/v2/client";
import { type MutableRefObject, useCallback, useEffect, useRef } from "react";
import type { OpenCodeBridge, SelectedModel } from "@/types/electron";
import type { QueuedPrompt, Session } from "../use-opencode";
import type { VariantSelections } from "./use-variant";
import { resolveVariant } from "./use-variant";

type DispatchAction =
	| { type: "SET_BUSY"; payload: boolean }
	| { type: "SET_ERROR"; payload: string | null }
	| { type: "CLEAR_DRAFT_SESSION" }
	| { type: "MARK_SESSION_TEMPORARY"; payload: string }
	| { type: "QUEUE_ADD"; payload: { sessionID: string; prompt: QueuedPrompt } }
	| { type: "QUEUE_SHIFT"; payload: { sessionID: string } }
	| { type: "QUEUE_REMOVE"; payload: { sessionID: string; promptID: string } }
	| {
			type: "QUEUE_REORDER";
			payload: { sessionID: string; fromIndex: number; toIndex: number };
	  }
	| {
			type: "QUEUE_UPDATE";
			payload: { sessionID: string; promptID: string; text: string };
	  }
	| {
			type: "SET_PERMISSION";
			payload: { sessionID: string; clear: true };
	  }
	| {
			type: "SET_QUESTION";
			payload: { sessionID: string; clear: true };
	  };

interface UseMessagesParams {
	bridge: OpenCodeBridge | undefined;
	state: {
		activeSessionId: string | null;
		draftSessionDirectory: string | null;
		draftIsTemporary: boolean;
		busySessionIds: Set<string>;
		selectedModel: SelectedModel | null;
		selectedAgent: string | null;
		variantSelections: VariantSelections;
		agents: Agent[];
		queuedPrompts: Record<string, QueuedPrompt[]>;
		pendingPermissions: Record<string, { id: string }>;
		pendingQuestions: Record<string, { id: string }>;
		sessions: Session[];
		temporarySessions: Set<string>;
	};
	dispatch: (action: DispatchAction) => void;
	createSession: (
		title?: string,
		directory?: string,
	) => Promise<Session | null>;
	selectSession: (id: string | null) => Promise<void>;
	currentVariant: string | undefined;
	selectedModelRef: MutableRefObject<SelectedModel | null>;
	selectedAgentRef: MutableRefObject<string | null>;
	variantSelectionsRef: MutableRefObject<VariantSelections>;
	agentsRef: MutableRefObject<Agent[]>;
	temporarySessionsRef: MutableRefObject<Set<string>>;
	activeSessionIdRef: MutableRefObject<string | null>;
	isNotificationsEnabled: () => boolean;
}

export function useMessages({
	bridge,
	state,
	dispatch,
	createSession,
	selectSession,
	currentVariant,
	selectedModelRef,
	selectedAgentRef,
	variantSelectionsRef,
	agentsRef,
	temporarySessionsRef,
	activeSessionIdRef,
	isNotificationsEnabled,
}: UseMessagesParams) {
	const busySessionIdsRef = useRef(state.busySessionIds);
	busySessionIdsRef.current = state.busySessionIds;

	const dispatchingRef = useRef<Set<string>>(new Set());
	const draftCreatingRef = useRef(false);

	const dispatchPromptDirect = useCallback(
		async (
			sessionId: string,
			text: string,
			images?: string[],
			overrideModel?: SelectedModel,
			overrideAgent?: string,
			overrideVariant?: string,
		) => {
			if (!bridge) return;
			dispatch({ type: "SET_BUSY", payload: true });

			const model = overrideModel ?? state.selectedModel ?? undefined;
			const agent = overrideAgent ?? state.selectedAgent ?? undefined;
			const variant =
				overrideVariant ??
				resolveVariant(
					state.selectedModel,
					state.variantSelections,
					state.agents,
					state.selectedAgent,
				);

			const res = await bridge.prompt(
				sessionId,
				text,
				images,
				model,
				agent,
				variant,
			);
			if (!res.success) {
				dispatch({ type: "SET_ERROR", payload: res.error ?? "Prompt failed" });
				dispatch({ type: "SET_BUSY", payload: false });
			}
		},
		[
			bridge,
			dispatch,
			state.selectedModel,
			state.selectedAgent,
			state.variantSelections,
			state.agents,
		],
	);

	const dispatchNextQueued = useCallback(
		async (sessionId: string) => {
			if (dispatchingRef.current.has(sessionId)) return;
			const queue = state.queuedPrompts[sessionId];
			if (!queue || queue.length === 0) return;

			dispatchingRef.current.add(sessionId);
			const next = queue[0];
			if (!next) return;
			dispatch({ type: "QUEUE_SHIFT", payload: { sessionID: sessionId } });
			await dispatchPromptDirect(
				sessionId,
				next.text,
				next.images,
				next.model,
				next.agent,
				next.variant,
			);
			dispatchingRef.current.delete(sessionId);
		},
		[state.queuedPrompts, dispatch, dispatchPromptDirect],
	);

	const sendPrompt = useCallback(
		async (text: string, images?: string[]) => {
			if (!bridge) return;
			let sessionId = state.activeSessionId;

			if (!sessionId && state.draftSessionDirectory) {
				if (draftCreatingRef.current) return;
				draftCreatingRef.current = true;
				const wasTemporary = state.draftIsTemporary;
				try {
					const newSession = await createSession(
						undefined,
						state.draftSessionDirectory,
					);
					if (!newSession) {
						draftCreatingRef.current = false;
						return;
					}
					dispatch({ type: "CLEAR_DRAFT_SESSION" });
					sessionId = newSession.id;
					if (wasTemporary) {
						dispatch({
							type: "MARK_SESSION_TEMPORARY",
							payload: newSession.id,
						});
					}
				} catch {
					draftCreatingRef.current = false;
					return;
				}
				draftCreatingRef.current = false;
			}

			if (!sessionId) {
				dispatch({
					type: "SET_ERROR",
					payload: "Select or create a session first.",
				});
				return;
			}

			if (state.busySessionIds.has(sessionId)) {
				const snapModel = selectedModelRef.current;
				const snapAgent = selectedAgentRef.current;
				const snapVariant = resolveVariant(
					snapModel,
					variantSelectionsRef.current,
					agentsRef.current,
					snapAgent,
				);
				const queued: QueuedPrompt = {
					id: crypto.randomUUID(),
					text,
					images,
					createdAt: Date.now(),
					model: snapModel ?? undefined,
					agent: snapAgent ?? undefined,
					variant: snapVariant,
				};
				dispatch({
					type: "QUEUE_ADD",
					payload: { sessionID: sessionId, prompt: queued },
				});
				return;
			}

			await dispatchPromptDirect(sessionId, text, images);
		},
		[
			bridge,
			state.activeSessionId,
			state.draftSessionDirectory,
			state.draftIsTemporary,
			state.busySessionIds,
			dispatch,
			createSession,
			dispatchPromptDirect,
			selectedModelRef,
			selectedAgentRef,
			variantSelectionsRef,
			agentsRef,
		],
	);

	const sendCommand = useCallback(
		async (command: string, args: string) => {
			if (!bridge) return;
			let sessionId = state.activeSessionId;

			if (!sessionId && state.draftSessionDirectory) {
				if (draftCreatingRef.current) return;
				draftCreatingRef.current = true;
				const wasTemporary = state.draftIsTemporary;
				try {
					const newSession = await createSession(
						undefined,
						state.draftSessionDirectory,
					);
					if (!newSession) {
						draftCreatingRef.current = false;
						return;
					}
					dispatch({ type: "CLEAR_DRAFT_SESSION" });
					sessionId = newSession.id;
					if (wasTemporary) {
						dispatch({
							type: "MARK_SESSION_TEMPORARY",
							payload: newSession.id,
						});
					}
				} catch {
					draftCreatingRef.current = false;
					return;
				}
				draftCreatingRef.current = false;
			}

			if (!sessionId) {
				dispatch({
					type: "SET_ERROR",
					payload: "Select or create a session first.",
				});
				return;
			}

			dispatch({ type: "SET_BUSY", payload: true });
			try {
				const model = state.selectedModel ?? undefined;
				const agent = state.selectedAgent ?? undefined;
				await bridge.sendCommand(
					sessionId,
					command,
					args,
					model,
					agent,
					currentVariant,
				);
			} catch (err) {
				dispatch({ type: "SET_BUSY", payload: false });
				dispatch({
					type: "SET_ERROR",
					payload: err instanceof Error ? err.message : String(err),
				});
			}
		},
		[
			bridge,
			state.activeSessionId,
			state.draftSessionDirectory,
			state.draftIsTemporary,
			state.selectedModel,
			state.selectedAgent,
			dispatch,
			createSession,
			currentVariant,
		],
	);

	useEffect(() => {
		const prevBusy = new Set<string>();
		for (const id of busySessionIdsRef.current) prevBusy.add(id);
		const nowBusy = state.busySessionIds;

		for (const sessionId of prevBusy) {
			if (!nowBusy.has(sessionId)) {
				dispatchNextQueued(sessionId);
				if (
					sessionId !== state.activeSessionId &&
					isNotificationsEnabled() &&
					typeof Notification !== "undefined" &&
					Notification.permission === "granted"
				) {
					const session = state.sessions.find((s) => s.id === sessionId);
					if (session) {
						const notification = new Notification("Session complete", {
							body: session.title || "Untitled",
						});
						notification.onclick = () => {
							window.focus();
							selectSession(sessionId);
						};
					}
				}
			}
		}
		busySessionIdsRef.current = new Set(nowBusy);
	}, [
		state.busySessionIds,
		state.activeSessionId,
		state.sessions,
		dispatchNextQueued,
		selectSession,
		isNotificationsEnabled,
	]);

	const prevQuestionsRef = useRef<Set<string>>(new Set());
	useEffect(() => {
		const prevKeys = prevQuestionsRef.current;
		const nowKeys = new Set(Object.keys(state.pendingQuestions));
		for (const sessionId of nowKeys) {
			if (
				!prevKeys.has(sessionId) &&
				sessionId !== state.activeSessionId &&
				isNotificationsEnabled() &&
				typeof Notification !== "undefined" &&
				Notification.permission === "granted"
			) {
				const session = state.sessions.find((s) => s.id === sessionId);
				if (session) {
					const notification = new Notification("Question waiting", {
						body: session.title || "Untitled",
					});
					notification.onclick = () => {
						window.focus();
						selectSession(sessionId);
					};
				}
			}
		}
		prevQuestionsRef.current = nowKeys;
	}, [
		state.pendingQuestions,
		state.activeSessionId,
		state.sessions,
		selectSession,
		isNotificationsEnabled,
	]);

	const prevPermissionsRef = useRef<Set<string>>(new Set());
	useEffect(() => {
		const prevKeys = prevPermissionsRef.current;
		const nowKeys = new Set(Object.keys(state.pendingPermissions));
		for (const sessionId of nowKeys) {
			if (
				!prevKeys.has(sessionId) &&
				sessionId !== state.activeSessionId &&
				isNotificationsEnabled() &&
				typeof Notification !== "undefined" &&
				Notification.permission === "granted"
			) {
				const session = state.sessions.find((s) => s.id === sessionId);
				if (session) {
					const notification = new Notification("Permission requested", {
						body: session.title || "Untitled",
					});
					notification.onclick = () => {
						window.focus();
						selectSession(sessionId);
					};
				}
			}
		}
		prevPermissionsRef.current = nowKeys;
	}, [
		state.pendingPermissions,
		state.activeSessionId,
		state.sessions,
		selectSession,
		isNotificationsEnabled,
	]);

	const abortSession = useCallback(async () => {
		if (!bridge || !state.activeSessionId) return;
		await bridge.abort(state.activeSessionId);
	}, [bridge, state.activeSessionId]);

	const respondPermission = useCallback(
		async (response: "once" | "always" | "reject") => {
			if (!bridge || !state.activeSessionId) return;
			const pending = state.pendingPermissions[state.activeSessionId];
			if (!pending) return;
			await bridge.respondPermission(
				state.activeSessionId,
				pending.id,
				response,
			);
			dispatch({
				type: "SET_PERMISSION",
				payload: { sessionID: state.activeSessionId, clear: true },
			});
		},
		[bridge, dispatch, state.pendingPermissions, state.activeSessionId],
	);

	const replyQuestion = useCallback(
		async (answers: QuestionAnswer[]) => {
			if (!bridge || !state.activeSessionId) return;
			const pending = state.pendingQuestions[state.activeSessionId];
			if (!pending) return;
			await bridge.replyQuestion(pending.id, answers);
			dispatch({
				type: "SET_QUESTION",
				payload: { sessionID: state.activeSessionId, clear: true },
			});
		},
		[bridge, dispatch, state.pendingQuestions, state.activeSessionId],
	);

	const rejectQuestion = useCallback(async () => {
		if (!bridge || !state.activeSessionId) return;
		const pending = state.pendingQuestions[state.activeSessionId];
		if (!pending) return;
		await bridge.rejectQuestion(pending.id);
		dispatch({
			type: "SET_QUESTION",
			payload: { sessionID: state.activeSessionId, clear: true },
		});
	}, [bridge, dispatch, state.pendingQuestions, state.activeSessionId]);

	const getQueuedPrompts = useCallback(
		(sessionId: string) => state.queuedPrompts[sessionId] ?? [],
		[state.queuedPrompts],
	);

	const removeFromQueue = useCallback(
		(sessionId: string, promptId: string) => {
			dispatch({
				type: "QUEUE_REMOVE",
				payload: { sessionID: sessionId, promptID: promptId },
			});
		},
		[dispatch],
	);

	const reorderQueue = useCallback(
		(sessionId: string, fromIndex: number, toIndex: number) => {
			dispatch({
				type: "QUEUE_REORDER",
				payload: { sessionID: sessionId, fromIndex, toIndex },
			});
		},
		[dispatch],
	);

	const updateQueuedPrompt = useCallback(
		(sessionId: string, promptId: string, text: string) => {
			dispatch({
				type: "QUEUE_UPDATE",
				payload: { sessionID: sessionId, promptID: promptId, text },
			});
		},
		[dispatch],
	);

	const sendQueuedNow = useCallback(
		async (sessionId: string, promptId: string) => {
			const queue = state.queuedPrompts[sessionId] ?? [];
			if (queue.length === 0) return;
			const index = queue.findIndex((item) => item.id === promptId);
			if (index === -1) return;
			const target = queue[index];
			if (!target) return;

			if (busySessionIdsRef.current.has(sessionId)) {
				if (index > 0) {
					dispatch({
						type: "QUEUE_REORDER",
						payload: { sessionID: sessionId, fromIndex: index, toIndex: 0 },
					});
				}
				if (bridge) {
					await bridge.abort(sessionId);
				}
				return;
			}

			dispatch({
				type: "QUEUE_REMOVE",
				payload: { sessionID: sessionId, promptID: promptId },
			});

			await dispatchPromptDirect(
				sessionId,
				target.text,
				target.images,
				target.model,
				target.agent,
				target.variant,
			);
		},
		[state.queuedPrompts, bridge, dispatch, dispatchPromptDirect],
	);

	useEffect(() => {
		activeSessionIdRef.current = state.activeSessionId;
	}, [state.activeSessionId, activeSessionIdRef]);

	useEffect(() => {
		temporarySessionsRef.current = state.temporarySessions ?? new Set<string>();
	}, [state, temporarySessionsRef]);

	return {
		sendPrompt,
		sendCommand,
		abortSession,
		respondPermission,
		replyQuestion,
		rejectQuestion,
		getQueuedPrompts,
		removeFromQueue,
		reorderQueue,
		updateQueuedPrompt,
		sendQueuedNow,
	};
}
