import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const require = createRequire(import.meta.url);
const electronPackagePath = require.resolve("electron/package.json");
const electronDir = path.dirname(electronPackagePath);
const electronRequire = createRequire(electronPackagePath);
const { version } = electronRequire("./package.json");
const { downloadArtifact } = electronRequire("@electron/get");

function getPlatformPath(platform = os.platform()) {
  switch (platform) {
    case "mas":
    case "darwin":
      return "Electron.app/Contents/MacOS/Electron";
    case "freebsd":
    case "openbsd":
    case "linux":
      return "electron";
    case "win32":
      return "electron.exe";
    default:
      throw new Error(`Electron builds are not available on platform: ${platform}`);
  }
}

async function ensureElectron() {
  const platform =
    process.env.ELECTRON_INSTALL_PLATFORM || process.env.npm_config_platform || process.platform;
  const arch = process.env.ELECTRON_INSTALL_ARCH || process.env.npm_config_arch || process.arch;
  const platformPath = getPlatformPath(platform);
  const distDir = path.join(electronDir, "dist");
  const pathFile = path.join(electronDir, "path.txt");
  const versionFile = path.join(distDir, "version");
  const executablePath = path.join(distDir, platformPath);

  const installed =
    fs.existsSync(executablePath) &&
    fs.existsSync(pathFile) &&
    fs.existsSync(versionFile) &&
    fs.readFileSync(pathFile, "utf8") === platformPath &&
    fs.readFileSync(versionFile, "utf8").replace(/^v/, "") === version;

  if (installed) return;

  await fsp.rm(distDir, { recursive: true, force: true });
  await fsp.mkdir(distDir, { recursive: true });

  const zipPath = await downloadArtifact({
    version,
    artifactName: "electron",
    platform,
    arch,
    force: process.env.force_no_cache === "true",
    cacheRoot: process.env.electron_config_cache,
    checksums:
      process.env.electron_use_remote_checksums ||
      process.env.npm_config_electron_use_remote_checksums
        ? undefined
        : electronRequire("./checksums.json"),
  });

  execFileSync("unzip", ["-q", zipPath, "-d", distDir], { stdio: "inherit" });

  const bundledTypes = path.join(distDir, "electron.d.ts");
  if (fs.existsSync(bundledTypes)) {
    await fsp.rename(bundledTypes, path.join(electronDir, "electron.d.ts"));
  }

  await fsp.writeFile(pathFile, platformPath, "utf8");
}

ensureElectron().catch((error) => {
  console.error(error);
  process.exit(1);
});
