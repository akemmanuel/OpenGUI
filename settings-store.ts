import fs from "node:fs";
import path from "node:path";

const SETTINGS_FILE_NAME = "settings.json";
const SETTINGS_VERSION = 1;

type SettingsValues = Record<string, string>;

type SettingsPayload = {
  version: number;
  values: SettingsValues;
};

function normalizeValues(input: unknown): SettingsValues {
  if (!input || typeof input !== "object" || Array.isArray(input)) return {};
  const values: SettingsValues = {};
  for (const [key, value] of Object.entries(input)) {
    if (typeof key !== "string") continue;
    if (typeof value === "string") {
      values[key] = value;
    }
  }
  return values;
}

function readSettingsFile(filePath: string): SettingsPayload {
  try {
    const raw = fs.readFileSync(filePath, "utf8");
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      if (parsed.values && typeof parsed.values === "object") {
        return {
          version: typeof parsed.version === "number" ? parsed.version : SETTINGS_VERSION,
          values: normalizeValues(parsed.values),
        };
      }
      // Backward-compatible fallback if file ever contained flat object.
      return {
        version: SETTINGS_VERSION,
        values: normalizeValues(parsed),
      };
    }
  } catch {
    // Ignore missing or malformed file; start fresh.
  }
  return { version: SETTINGS_VERSION, values: {} };
}

function writeSettingsFile(filePath: string, payload: SettingsPayload) {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  const tempPath = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tempPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  fs.renameSync(tempPath, filePath);
}

function createSettingsStore(baseDir: string) {
  const filePath = path.join(baseDir, SETTINGS_FILE_NAME);
  let state = readSettingsFile(filePath);

  function flush() {
    state = {
      version: SETTINGS_VERSION,
      values: normalizeValues(state.values),
    };
    writeSettingsFile(filePath, state);
  }

  return {
    filePath,
    getAll() {
      return { ...state.values };
    },
    get(key: string) {
      if (typeof key !== "string") return null;
      return state.values[key] ?? null;
    },
    set(key: string, value: string) {
      if (typeof key !== "string" || typeof value !== "string") return false;
      state.values[key] = value;
      flush();
      return true;
    },
    remove(key: string) {
      if (typeof key !== "string") return false;
      if (!(key in state.values)) return true;
      delete state.values[key];
      flush();
      return true;
    },
    merge(entries: unknown) {
      if (!entries || typeof entries !== "object" || Array.isArray(entries)) {
        return false;
      }
      let changed = false;
      for (const [key, value] of Object.entries(entries)) {
        if (typeof key !== "string" || typeof value !== "string") continue;
        if (state.values[key] === value) continue;
        state.values[key] = value;
        changed = true;
      }
      if (changed) flush();
      return true;
    },
  };
}

export { SETTINGS_FILE_NAME, SETTINGS_VERSION, createSettingsStore };
