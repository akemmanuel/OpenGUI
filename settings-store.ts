import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

const SETTINGS_FILE_NAME = "settings.json";
const SETTINGS_VERSION = 1;
const MAX_SETTINGS_KEY_LENGTH = 256;
const MAX_SETTINGS_VALUE_LENGTH = 1_000_000;

type SettingsValues = Record<string, string>;

type SettingsPayload = {
  version: number;
  values: SettingsValues;
};

function isValidSetting(key: unknown, value: unknown): key is string {
  return (
    typeof key === "string" &&
    key.length > 0 &&
    key.length <= MAX_SETTINGS_KEY_LENGTH &&
    typeof value === "string" &&
    value.length <= MAX_SETTINGS_VALUE_LENGTH
  );
}

function normalizeValues(input: unknown): SettingsValues {
  if (!input || typeof input !== "object" || Array.isArray(input)) return {};
  const values: SettingsValues = {};
  for (const [key, value] of Object.entries(input)) {
    if (isValidSetting(key, value)) {
      values[key] = value;
    }
  }
  return values;
}

type SettingsFileSystem = Pick<
  typeof fs,
  | "readFileSync"
  | "mkdirSync"
  | "writeFileSync"
  | "renameSync"
  | "unlinkSync"
  | "openSync"
  | "fsyncSync"
  | "closeSync"
>;

class SettingsCommitError extends Error {
  readonly committed = true;
}

function readSettingsFile(filePath: string, fileSystem: SettingsFileSystem): SettingsPayload {
  try {
    const raw = fileSystem.readFileSync(filePath, "utf8");
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

function writeSettingsFile(
  filePath: string,
  payload: SettingsPayload,
  fileSystem: SettingsFileSystem,
) {
  const dir = path.dirname(filePath);
  fileSystem.mkdirSync(dir, { recursive: true });
  const tempPath = `${filePath}.tmp-${process.pid}-${randomUUID()}`;
  let replaced = false;
  try {
    fileSystem.writeFileSync(tempPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
    const temporaryFile = fileSystem.openSync(tempPath, "r+");
    try {
      fileSystem.fsyncSync(temporaryFile);
    } finally {
      fileSystem.closeSync(temporaryFile);
    }
    fileSystem.renameSync(tempPath, filePath);
    replaced = true;
    let directory: number | undefined;
    try {
      directory = fileSystem.openSync(dir, "r");
      fileSystem.fsyncSync(directory);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (!code || !["EISDIR", "EINVAL", "ENOTSUP", "EPERM"].includes(code)) {
        throw new SettingsCommitError(
          `The settings file was replaced, but directory durability could not be confirmed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    } finally {
      if (directory !== undefined) fileSystem.closeSync(directory);
    }
  } catch (error) {
    if (!replaced) {
      try {
        fileSystem.unlinkSync(tempPath);
      } catch {
        // The temporary file may not have been created. Preserve the write error.
      }
    }
    throw error;
  }
}

function createSettingsStore(baseDir: string, fileSystem: SettingsFileSystem = fs) {
  const filePath = path.join(baseDir, SETTINGS_FILE_NAME);
  let state = readSettingsFile(filePath, fileSystem);

  function persist(values: SettingsValues) {
    const nextState = {
      version: SETTINGS_VERSION,
      values: normalizeValues(values),
    };
    try {
      writeSettingsFile(filePath, nextState, fileSystem);
      state = nextState;
    } catch (error) {
      if (error instanceof SettingsCommitError) state = nextState;
      throw error;
    }
  }

  return {
    filePath,
    getAll() {
      return { ...state.values };
    },
    get(key: string) {
      if (typeof key !== "string" || key.length === 0 || key.length > MAX_SETTINGS_KEY_LENGTH)
        return null;
      return state.values[key] ?? null;
    },
    set(key: string, value: string) {
      if (!isValidSetting(key, value)) return false;
      persist({ ...state.values, [key]: value });
      return true;
    },
    remove(key: string) {
      if (typeof key !== "string" || key.length === 0 || key.length > MAX_SETTINGS_KEY_LENGTH)
        return false;
      if (!(key in state.values)) return true;
      const nextValues = { ...state.values };
      delete nextValues[key];
      persist(nextValues);
      return true;
    },
    merge(entries: unknown) {
      if (!entries || typeof entries !== "object" || Array.isArray(entries)) {
        return false;
      }
      let changed = false;
      const nextValues = { ...state.values };
      for (const [key, value] of Object.entries(entries)) {
        if (!isValidSetting(key, value)) continue;
        if (nextValues[key] === value) continue;
        nextValues[key] = value;
        changed = true;
      }
      if (changed) persist(nextValues);
      return true;
    },
  };
}

export { SETTINGS_FILE_NAME, SETTINGS_VERSION, createSettingsStore };
