#!/usr/bin/env node
import { spawn } from "node:child_process";

/** @type {Array<[string, string[]]>} */
const defaultSteps = [
  ["pnpm", ["run", "slop-check"]],
  ["pnpm", ["exec", "vp", "lint"]],
  ["pnpm", ["exec", "vp", "check"]],
  ["pnpm", ["exec", "vp", "test"]],
  ["pnpm", ["run", "session-read-acceptance"]],
  ["pnpm", ["exec", "vp", "build"]],
];

/** @type {Array<[string, string[]]>} */
const bridgeSteps = [
  ["pnpm", ["run", "test:runtime"]],
  ["pnpm", ["run", "test:bridges"]],
];

const includeBridge = process.argv.includes("--bridges");
const steps = includeBridge
  ? [...defaultSteps.slice(0, 4), ...bridgeSteps, ...defaultSteps.slice(4)]
  : defaultSteps;

for (const [command, args] of steps) {
  const label = `${command} ${args.join(" ")}`;
  console.log(`\n▶ ${label}`);
  const status = await new Promise((resolve) => {
    const child = spawn(command, args, { stdio: "inherit", shell: process.platform === "win32" });
    child.on("close", resolve);
    child.on("error", (error) => {
      console.error(error);
      resolve(1);
    });
  });
  if (status !== 0) {
    console.error(`\n✖ Failed: ${label}`);
    process.exit(status ?? 1);
  }
}

console.log("\n✓ Ultracode quality gate passed");
