export type AppUpdateStatus =
  | "idle"
  | "checking"
  | "available"
  | "downloading"
  | "downloaded"
  | "not-available"
  | "error"
  | "installing"
  | "disabled";

export interface AppUpdateState {
  status: AppUpdateStatus;
  platformSupported: boolean;
  currentVersion: string;
  latestVersion: string | null;
  releaseDate: string | null;
  releaseNotes: string | null;
  releaseName: string | null;
  releaseUrl: string | null;
  progressPercent: number | null;
  bytesPerSecond: number | null;
  transferred: number | null;
  total: number | null;
  errorMessage: string | null;
  downloaded: boolean;
  autoDownload: boolean;
  updateInfoFetched: boolean;
}

export interface UpdatesBridge {
  getState(): Promise<AppUpdateState>;
  check(): Promise<AppUpdateState>;
  download(): Promise<AppUpdateState>;
  install(): Promise<boolean>;
  onStateChanged(callback: (state: AppUpdateState) => void): () => void;
}

export interface InstallProgress {
  chunk: string;
  type: "stdout" | "stderr";
}

export type DesktopBackendStatus = "starting" | "running" | "stopped" | "crashed";

export interface DesktopBackendFetchRequest {
  url: string;
  method?: string;
  headers?: Record<string, string>;
  body?: string | null;
}

export interface DesktopBackendFetchResponse {
  status: number;
  statusText: string;
  headers: Record<string, string>;
  body: string;
}
