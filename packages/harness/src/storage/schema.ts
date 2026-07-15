export interface SessionTable {
  id: string;
  project_directory: string;
  title: string;
  created_at: string;
  updated_at: string;
}

export interface SessionEntryTable {
  id: string;
  session_id: string;
  sequence: number;
  kind: string;
  payload_json: string;
  created_at: string;
}

export interface SessionFollowUpTable {
  id: string;
  session_id: string;
  sequence: number;
  prompt_json: string;
  state: string;
  created_at: string;
}

export interface SettingTable {
  key: string;
  value_json: string;
}

export interface HarnessDatabase {
  sessions: SessionTable;
  session_entries: SessionEntryTable;
  session_follow_ups: SessionFollowUpTable;
  settings: SettingTable;
}
