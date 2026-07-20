import type { SettingsBridge } from "./settings";
import type {
  DesktopBackendFetchRequest,
  DesktopBackendFetchResponse,
  DesktopBackendStatus,
  UpdatesBridge,
} from "./shell";

/** Standard IPC result envelope. */
export interface IPCResult<T = unknown> {
  success: boolean;
  data?: T;
  error?: string;
}

export interface ElectronAPI {
  kind?: "electron" | "web";
  backendUrl?: string | null;
  backendToken?: string | null;
  backendStatus?: DesktopBackendStatus;
  settings: SettingsBridge;
  minimize: () => Promise<void>;
  maximize: () => Promise<void>;
  close: () => Promise<void>;
  isMaximized: () => Promise<boolean>;
  focus: () => Promise<void>;
  getPlatform: () => Promise<string>;
  getSystemLocale: () => Promise<string>;
  isPackaged: () => Promise<boolean>;
  getHomeDir?: () => Promise<string>;
  restartBackend?: () => Promise<{
    url: string;
    token: string | null;
    status: DesktopBackendStatus;
  }>;
  backendFetch?: (request: DesktopBackendFetchRequest) => Promise<DesktopBackendFetchResponse>;
  subscribeBackendEvents?: (
    callback: (message: { channel?: string; data?: unknown } | Record<string, unknown>) => void,
  ) => () => void;
  onMaximizeChange: (callback: (isMaximized: boolean) => void) => () => void;
  onBackendStatusChange?: (callback: (status: DesktopBackendStatus) => void) => () => void;
  openDirectory: () => Promise<string | null>;
  openExternal: (url: string) => Promise<void>;
  updates: UpdatesBridge;
  openInFileBrowser: (dirPath: string, command?: string) => Promise<void>;
  openInTerminal: (dirPath: string, command?: string) => Promise<void>;
  detachProject: (projectDir: string) => Promise<void>;
  getDetachedProject: () => string | null;
  getDetachedProjects: () => Promise<string[]>;
  onDetachedProjectsChange: (callback: (detachedProjects: string[]) => void) => () => void;
}
