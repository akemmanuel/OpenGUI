#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { basename, resolve } from "node:path";

function arg(name, fallback) {
  const prefix = `--${name}=`;
  const exact = `--${name}`;
  const index = process.argv.findIndex((item) => item === exact || item.startsWith(prefix));
  if (index === -1) return fallback;
  const value = process.argv[index];
  if (value.startsWith(prefix)) return value.slice(prefix.length);
  return process.argv[index + 1] ?? fallback;
}

const baseUrl = (arg("base", process.env.OPENGUI_BASE_URL) || "http://127.0.0.1:3000").replace(
  /\/$/,
  "",
);
const token = arg("token", process.env.OPENGUI_AUTH_TOKEN || "");
const directory = resolve(arg("directory", process.cwd()));
const workspaceId = arg("workspace", process.env.OPENGUI_WORKSPACE_ID || "local");
const modelArg = arg("model", "");
const imagePath = arg("image", "");
const timeoutMs = Number(arg("timeout-ms", "120000"));

const headers = token ? { Authorization: `Bearer ${token}` } : {};

async function request(path, init = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    ...init,
    headers: { ...headers, ...init.headers },
  });
  const text = await response.text();
  let body;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    throw new Error(
      `${init.method || "GET"} ${path} returned non-JSON ${response.status}: ${text.slice(0, 500)}`,
    );
  }
  if (!response.ok || body?.ok === false) {
    throw new Error(
      `${init.method || "GET"} ${path} failed ${response.status}: ${body?.error || text}`,
    );
  }
  return body;
}

async function rpc(channel, args = []) {
  const body = await request("/api/rpc", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ channel, args }),
  });
  const value = body.value;
  if (value?.success === false) throw new Error(`${channel} failed: ${value.error}`);
  return value?.data ?? value;
}

async function uploadImage() {
  let bytes;
  let name;
  if (imagePath) {
    const absolute = resolve(imagePath);
    bytes = await readFile(absolute);
    name = basename(absolute);
  } else {
    bytes = await readFile(new URL("../screenshot.png", import.meta.url));
    name = "opengui-probe-screenshot.png";
  }

  const form = new FormData();
  form.append("files", new Blob([bytes], { type: "image/png" }), name);
  const body = await request("/api/fs/upload", { method: "POST", body: form });
  return body.value[0];
}

function findReadResult(messagesJson) {
  const text = JSON.stringify(messagesJson);
  if (text.includes("[Image omitted: could not be resized below the inline image size limit.]")) {
    return { status: "failed-resize", evidence: "found Pi resize omission text" };
  }
  if (
    text.includes("data:image/") ||
    text.includes('"mime":"image/') ||
    text.includes('"mimeType":"image/')
  ) {
    return { status: "image-attached", evidence: "found image attachment/data URL in messages" };
  }
  if (text.includes("Read image file [image/")) {
    return {
      status: "read-text-only-or-pending",
      evidence: "found read text but no image attachment yet",
    };
  }
  return null;
}

console.log(`OpenGUI: ${baseUrl}`);
console.log(`Directory: ${directory}`);

const health = await request("/api/health");
console.log("Health:", JSON.stringify(health));

const uploadedPath = await uploadImage();
console.log(`Uploaded: ${uploadedPath}`);

const model = modelArg
  ? (() => {
      const [providerID, modelID] = modelArg.split("/", 2);
      if (!providerID || !modelID)
        throw new Error("--model must be provider/model, e.g. anthropic/claude-sonnet-4-20250514");
      return { providerID, modelID };
    })()
  : undefined;

const session = await rpc("pi:session:start", [
  {
    title: "OpenGUI Pi image read probe",
    text: `Use the read tool on exactly this path and say whether you received an image attachment: @${uploadedPath}`,
    images: [],
    directory,
    workspaceId,
    ...(model ? { model } : {}),
  },
]);

console.log(`Session: ${session.id}`);

const deadline = Date.now() + timeoutMs;
let lastMessages;
let result;
while (Date.now() < deadline) {
  lastMessages = await rpc("pi:messages", [session.id, {}, directory, workspaceId]);
  result = findReadResult(lastMessages);
  if (result && result.status !== "read-text-only-or-pending") break;
  await new Promise((resolve) => setTimeout(resolve, 1500));
}

console.log(
  "Result:",
  result || { status: "timeout", evidence: "no read result found before timeout" },
);

if (result?.status === "failed-resize") {
  console.log("Diagnosis: OpenGUI API reproduced the Pi daemon image resize failure.");
  process.exitCode = 2;
} else if (result?.status === "image-attached") {
  console.log("Diagnosis: OpenGUI API returned an image attachment successfully.");
} else {
  console.log("Last messages snapshot:");
  console.log(JSON.stringify(lastMessages, null, 2).slice(0, 8000));
  process.exitCode = 1;
}
