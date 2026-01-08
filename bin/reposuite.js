#!/usr/bin/env node
const path = require("path");
const { spawn } = require("child_process");

function normalizePlatform(platform) {
  if (platform === "darwin") return "darwin";
  if (platform === "linux") return "linux";
  if (platform === "win32") return "windows";
  return null;
}

function normalizeArch(arch) {
  if (arch === "x64") return "amd64";
  if (arch === "arm64") return "arm64";
  return null;
}

const platform = normalizePlatform(process.platform);
const arch = normalizeArch(process.arch);

if (!platform || !arch) {
  console.error(
    `Unsupported platform or architecture: ${process.platform}/${process.arch}`
  );
  process.exit(1);
}

const exeName = platform === "windows" ? "reposuite.exe" : "reposuite";
const binPath = path.join(
  __dirname,
  "..",
  ".reposuite",
  "bin",
  platform,
  arch,
  exeName
);

try {
  require("fs").accessSync(binPath);
} catch (error) {
  console.error("RepoSuite binary not found.");
  console.error(`Expected path: ${binPath}`);
  console.error(
    "Reinstall the package or run `node scripts/install.js` from this directory."
  );
  process.exit(1);
}

const child = spawn(binPath, process.argv.slice(2), { stdio: "inherit" });

child.on("exit", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code === null ? 1 : code);
});

child.on("error", (error) => {
  console.error(`Failed to start RepoSuite: ${error.message}`);
  process.exit(1);
});
