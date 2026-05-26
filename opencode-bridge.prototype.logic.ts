export interface PrototypeTarget {
  directory: string;
  workspaceId: string;
  baseUrl: string;
  username?: string;
  password?: string;
}

export interface PrototypeState {
  question: string;
  target: PrototypeTarget;
  selectedProviderID: string;
  providers: {
    total: number;
    connected: string[];
    sample: string[];
    selected: { id: string } | null;
  };
  authMethods: Record<string, Array<{ type?: string; label?: string }>>;
  lastOAuth: Record<string, unknown> | null;
  lastAction: string;
  lastError: string | null;
  history: string[];
}

export function createInitialState(input: {
  question: string;
  target: PrototypeTarget;
  selectedProviderID?: string;
}): PrototypeState {
  return {
    question: input.question,
    target: input.target,
    selectedProviderID: input.selectedProviderID || "openrouter",
    providers: {
      total: 0,
      connected: [],
      sample: [],
      selected: null,
    },
    authMethods: {},
    lastOAuth: null,
    lastAction: "boot",
    lastError: null,
    history: [],
  };
}

export function reducePrototypeState(
  state: PrototypeState,
  event:
    | { type: "selected-provider"; providerID: string }
    | {
        type: "refreshed";
        providers: { all: Array<{ id: string }>; connected: string[] };
        authMethods: Record<string, Array<{ type?: string; label?: string }>>;
      }
    | { type: "oauth-started"; providerID: string; authorization: Record<string, unknown> }
    | { type: "action"; message: string }
    | { type: "error"; message: string },
): PrototypeState {
  if (event.type === "selected-provider") {
    return {
      ...state,
      selectedProviderID: event.providerID,
      lastAction: `selected ${event.providerID}`,
      lastError: null,
      history: [...state.history, `selected ${event.providerID}`].slice(-8),
    };
  }

  if (event.type === "refreshed") {
    const selected =
      event.providers.all.find((provider) => provider.id === state.selectedProviderID) || null;
    return {
      ...state,
      providers: {
        total: event.providers.all.length,
        connected: [...event.providers.connected].sort(),
        sample: event.providers.all.slice(0, 12).map((provider) => provider.id),
        selected,
      },
      authMethods: event.authMethods,
      lastAction: `refreshed provider state (${event.providers.all.length} providers)`,
      lastError: null,
      history: [...state.history, `refresh -> ${event.providers.all.length} providers`].slice(-8),
    };
  }

  if (event.type === "oauth-started") {
    return {
      ...state,
      selectedProviderID: event.providerID,
      lastOAuth: event.authorization,
      lastAction: `started oauth for ${event.providerID}`,
      lastError: null,
      history: [...state.history, `oauth -> ${event.providerID}`].slice(-8),
    };
  }

  if (event.type === "action") {
    return {
      ...state,
      lastAction: event.message,
      lastError: null,
      history: [...state.history, event.message].slice(-8),
    };
  }

  return {
    ...state,
    lastError: event.message,
    history: [...state.history, `error -> ${event.message}`].slice(-8),
  };
}
