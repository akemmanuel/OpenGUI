import type { Agent, Command, PermissionRequest, QuestionRequest } from "@/protocol/harness-types";
import type { HarnessId } from "@/agents";
import type { ProjectHydrationState } from "@/hooks/agent-project-hydration";
import type {
  InternalAgentState,
  MessageEntry,
  QueuedPrompt,
  Session,
} from "@/hooks/agent-state-types";
import type { ProjectMeta, SessionMeta } from "@/hooks/agent-state-persistence";
import type { VariantSelections } from "@/hooks/use-agent-variant-core";
import type { ConnectionStatus, ProvidersData, SelectedModel, Workspace } from "@/types/electron";
import type { SessionListTargetSource } from "@/hooks/agent-project-connection";

export type Action =
  | { type: "SET_WORKSPACES"; payload: Workspace[] }
  | {
      type: "ADD_WORKSPACE_PROJECT";
      payload: {
        workspaceId: string;
        directory: string;
        serverUrl: string;
        username?: string;
        password?: string;
      };
    }
  | { type: "SET_ACTIVE_WORKSPACE"; payload: string }
  | {
      type: "REORDER_WORKSPACES";
      payload: { fromIndex: number; toIndex: number };
    }
  | {
      type: "REORDER_VISIBLE_WORKSPACE_PROJECTS";
      payload: { workspaceId: string; orderedDirectories: string[] };
    }
  | {
      type: "ASSIGN_PROJECT_WORKSPACE";
      payload: { projectKey: string; workspaceId: string };
    }
  | {
      type: "SET_PROJECT_CONNECTION";
      payload: { projectKey: string; status: ConnectionStatus };
    }
  | {
      type: "SET_PROJECT_HYDRATION";
      payload: { projectKey: string; hydration: ProjectHydrationState };
    }
  | { type: "RESET_PROJECT_HYDRATION" }
  | {
      type: "REMOVE_PROJECT";
      payload: { projectKey: string; directory: string };
    }
  | {
      type: "MERGE_PROJECT_SESSIONS";
      payload: {
        projectKey: string;
        directory: string;
        sessions: Session[];
        harnessIds?: HarnessId[];
        source?: SessionListTargetSource;
      };
    }
  | { type: "SET_ACTIVE_SESSION"; payload: string | null }
  | { type: "SET_SESSION_DRAFT"; payload: { key: string; text: string } }
  | { type: "CLEAR_SESSION_DRAFT"; payload: string }
  | { type: "SET_BUSY"; payload: boolean }
  | {
      type: "TURN_RUN_STARTED";
      payload: {
        id: string;
        sessionID: string;
        startedAt: number;
        providerID?: string;
        modelID?: string;
        thinkingLevel?: string;
      };
    }
  | { type: "SET_ERROR"; payload: string | null }
  | { type: "SESSION_ERROR"; payload: { sessionID?: string; error: string } }
  | {
      type: "SET_BOOT_STATE";
      payload: {
        state: InternalAgentState["bootState"];
        error?: string | null;
        logs?: string | null;
      };
    }
  | {
      type: "SET_PERMISSION";
      payload: PermissionRequest | { sessionID: string; clear: true };
    }
  | {
      type: "SET_QUESTION";
      payload: QuestionRequest | { sessionID: string; clear: true };
    }
  | {
      type: "SET_WORKSPACE_RESOURCES";
      payload: {
        workspaceId: string;
        harnessId: HarnessId;
        projectKey: string | null;
        providersData: ProvidersData;
        agentsData: Agent[];
        commandsData: Command[];
        variantSelections: VariantSelections;
      };
    }
  | { type: "ACTIVATE_WORKSPACE_RESOURCES"; payload: { workspaceId: string } }
  | { type: "EVICT_WORKSPACE_RESOURCES"; payload: { workspaceId: string } }
  | { type: "SET_PROVIDERS"; payload: ProvidersData }
  | { type: "SET_SELECTED_MODEL"; payload: SelectedModel | null }
  | {
      type: "SET_PROMPT_BOX_SELECTION";
      payload: { harnessId: HarnessId; model: SelectedModel };
    }
  | { type: "SET_AGENTS"; payload: Agent[] }
  | { type: "SET_COMMANDS"; payload: Command[] }
  | { type: "SET_SELECTED_AGENT"; payload: string | null }
  | { type: "SET_VARIANT_SELECTIONS"; payload: VariantSelections }
  | { type: "SESSION_CREATED"; payload: Session }
  | { type: "SESSION_UPDATED"; payload: Session }
  | { type: "SESSION_DELETED"; payload: string }
  | { type: "BIND_ASSISTANT_TURN_FROM_TRANSCRIPT"; payload: { entry: MessageEntry } }
  | {
      type: "SESSION_STATUS";
      payload: { sessionID: string; status: { type: string } };
    }
  | {
      type: "INIT_BUSY_SESSIONS";
      payload: Record<string, { type: string }>;
    }
  | { type: "SET_SESSION_QUEUE"; payload: { sessionID: string; prompts: QueuedPrompt[] } }
  | { type: "QUEUE_CLEAR"; payload: { sessionID: string } }
  | { type: "SET_DEFAULT_CHAT_DIRECTORY"; payload: string | null }
  | {
      type: "SET_ACTIVE_TARGET";
      payload: {
        directory: string;
        harnessId: HarnessId | null;
        resetSelection?: boolean;
        selectedModel?: SelectedModel | null;
        selectedAgent?: string | null;
      };
    }
  | { type: "CLEAR_ACTIVE_TARGET" }
  | { type: "SET_SESSION_NAMING"; payload: { sessionId: string; naming: boolean } }
  | {
      type: "SET_SESSION_META";
      payload: { sessionId: string; meta: SessionMeta };
    }
  | {
      type: "SET_PROJECT_META";
      payload: { projectKey: string; meta: ProjectMeta };
    }
  | {
      type: "REGISTER_WORKTREE";
      payload: { worktreeDir: string; parentDir: string; branch: string };
    }
  | { type: "UNREGISTER_WORKTREE"; payload: string }
  | {
      type: "SET_PENDING_WORKTREE_CLEANUP";
      payload: { worktreeDir: string; parentDir: string } | null;
    }
  | {
      type: "SET_AFTER_PART_PENDING";
      payload: { sessionID: string; pending: boolean };
    }
  | {
      type: "CLEAR_AFTER_PART_TRIGGERED";
      payload: { sessionID: string };
    }
  | {
      type: "SESSION_REPLACED";
      payload: { oldId: string; newId: string; session: Session };
    };
