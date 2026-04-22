export {
	AgentBackendProvider,
	getChildSessionParts,
	getWorktreeParentDir,
	hasAnyConnection,
	LOCAL_WORKSPACE_ID,
	NOTIFICATIONS_ENABLED_KEY,
	resolveServerDefaultModel,
	useActions,
	useConnectionState,
	useMessages,
	useModelState,
	useSessionState,
} from "./use-agent-impl";

export type {
	AgentBackendState,
	MessageEntry,
	QueueMode,
	QueuedPrompt,
	Session,
	SessionColor,
	WorktreeMetadata,
} from "./use-agent-impl";
