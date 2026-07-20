export interface SettingsBridgeChange {
  key: string;
  value: string | null;
}

export interface SettingsBridge {
  getAllSync(): Record<string, string>;
  getSync(key: string): string | null;
  setSync(key: string, value: string): boolean;
  removeSync(key: string): boolean;
  mergeSync(entries: Record<string, string>): boolean;
  set(key: string, value: string): Promise<boolean>;
  remove(key: string): Promise<boolean>;
  onDidChange(callback: (change: SettingsBridgeChange) => void): () => void;
}
