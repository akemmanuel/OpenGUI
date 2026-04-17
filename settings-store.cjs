const fs = require("node:fs");
const path = require("node:path");

const SETTINGS_FILE_NAME = "settings.json";
const SETTINGS_VERSION = 1;

function normalizeValues(input) {
	if (!input || typeof input !== "object" || Array.isArray(input)) return {};
	const values = {};
	for (const [key, value] of Object.entries(input)) {
		if (typeof key !== "string") continue;
		if (typeof value === "string") {
			values[key] = value;
		}
	}
	return values;
}

function readSettingsFile(filePath) {
	try {
		const raw = fs.readFileSync(filePath, "utf8");
		const parsed = JSON.parse(raw);
		if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
			if (parsed.values && typeof parsed.values === "object") {
				return {
					version:
						typeof parsed.version === "number"
							? parsed.version
							: SETTINGS_VERSION,
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

function writeSettingsFile(filePath, payload) {
	const dir = path.dirname(filePath);
	fs.mkdirSync(dir, { recursive: true });
	const tempPath = `${filePath}.tmp-${process.pid}-${Date.now()}`;
	fs.writeFileSync(tempPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
	fs.renameSync(tempPath, filePath);
}

function createSettingsStore(baseDir) {
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
		get(key) {
			if (typeof key !== "string") return null;
			return state.values[key] ?? null;
		},
		set(key, value) {
			if (typeof key !== "string" || typeof value !== "string") return false;
			state.values[key] = value;
			flush();
			return true;
		},
		remove(key) {
			if (typeof key !== "string") return false;
			if (!(key in state.values)) return true;
			delete state.values[key];
			flush();
			return true;
		},
		merge(entries) {
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

module.exports = {
	SETTINGS_FILE_NAME,
	SETTINGS_VERSION,
	createSettingsStore,
};
