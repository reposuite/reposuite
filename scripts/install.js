const fs = require("fs");
const os = require("os");
const path = require("path");
const https = require("https");
const crypto = require("crypto");
const { spawnSync } = require("child_process");

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

const owner = process.env.REPOSUITE_OWNER || "reposuite";
const repo = process.env.REPOSUITE_REPO || "reposuite";
const assetDirEnv = process.env.REPOSUITE_ASSET_DIR;

let version = process.env.REPOSUITE_VERSION;
if (!version) {
  const pkgPath = path.join(__dirname, "..", "package.json");
  const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
  version = `v${pkg.version}`;
}

const asset =
  platform === "windows"
    ? `reposuite_windows_${arch}.zip`
    : `reposuite_${platform}_${arch}.tar.gz`;

const url = `https://github.com/${owner}/${repo}/releases/download/${version}/${asset}`;
const checksumsUrl = `https://github.com/${owner}/${repo}/releases/download/${version}/checksums.txt`;
const bundledAssetDir = path.join(__dirname, "..", "assets");
const assetDir = assetDirEnv
  ? path.isAbsolute(assetDirEnv)
    ? assetDirEnv
    : path.join(__dirname, "..", assetDirEnv)
  : fs.existsSync(bundledAssetDir)
  ? bundledAssetDir
  : null;
const targetDir = path.join(
  __dirname,
  "..",
  ".reposuite",
  "bin",
  platform,
  arch
);
const exeName = platform === "windows" ? "reposuite.exe" : "reposuite";

function downloadToFile(sourceUrl, destPath, redirects = 0) {
  if (redirects > 5) {
    return Promise.reject(new Error("Too many redirects"));
  }

  return new Promise((resolve, reject) => {
    https
      .get(sourceUrl, (res) => {
        const redirect =
          res.statusCode >= 300 &&
          res.statusCode < 400 &&
          res.headers.location;
        if (redirect) {
          res.resume();
          resolve(downloadToFile(res.headers.location, destPath, redirects + 1));
          return;
        }

        if (res.statusCode !== 200) {
          res.resume();
          reject(
            new Error(`Download failed (${res.statusCode}) from ${sourceUrl}`)
          );
          return;
        }

        const file = fs.createWriteStream(destPath);
        res.pipe(file);
        file.on("finish", () => file.close(resolve));
        file.on("error", (error) => {
          file.close(() => reject(error));
        });
      })
      .on("error", reject);
  });
}

function downloadToString(sourceUrl, redirects = 0) {
  if (redirects > 5) {
    return Promise.reject(new Error("Too many redirects"));
  }

  return new Promise((resolve, reject) => {
    https
      .get(sourceUrl, (res) => {
        const redirect =
          res.statusCode >= 300 &&
          res.statusCode < 400 &&
          res.headers.location;
        if (redirect) {
          res.resume();
          resolve(downloadToString(res.headers.location, redirects + 1));
          return;
        }

        if (res.statusCode === 404) {
          res.resume();
          resolve(null);
          return;
        }

        if (res.statusCode !== 200) {
          res.resume();
          reject(
            new Error(`Download failed (${res.statusCode}) from ${sourceUrl}`)
          );
          return;
        }

        let data = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => {
          data += chunk;
        });
        res.on("end", () => resolve(data));
      })
      .on("error", reject);
  });
}

function sha256File(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash("sha256");
    const stream = fs.createReadStream(filePath);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("end", () => resolve(hash.digest("hex")));
    stream.on("error", reject);
  });
}

function extractArchive(archivePath) {
  if (platform === "windows") {
    const result = spawnSync(
      "powershell.exe",
      [
        "-NoProfile",
        "-Command",
        `Expand-Archive -Path "${archivePath}" -DestinationPath "${targetDir}" -Force`,
      ],
      { stdio: "inherit" }
    );
    if (result.status !== 0) {
      throw new Error("Failed to extract zip archive.");
    }
    return;
  }

  const result = spawnSync(
    "tar",
    ["-xzf", archivePath, "-C", targetDir],
    { stdio: "inherit" }
  );
  if (result.status !== 0) {
    throw new Error("Failed to extract tar.gz archive.");
  }
}

function findFileRecursive(dir, name) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isFile() && entry.name === name) {
      return fullPath;
    }
    if (entry.isDirectory()) {
      const found = findFileRecursive(fullPath, name);
      if (found) return found;
    }
  }
  return null;
}

async function verifyChecksum(archivePath) {
  const checksumText = await downloadToString(checksumsUrl);
  if (!checksumText) {
    throw new Error(
      "checksums.txt not found. Expected a file containing lines like: <sha256> <asset>"
    );
  }

  const lines = checksumText
    .split(/\r?\n/)
    .map((value) => value.trim())
    .filter(Boolean);

  let expected = null;
  for (const line of lines) {
    const parts = line.split(/\s+/);
    if (parts.length < 2) continue;
    const name = parts[1].replace(/^\*/, "");
    if (name === asset) {
      expected = parts[0];
      break;
    }
  }

  if (!expected) {
    throw new Error(
      `Checksum entry not found. Expected a line like: <sha256> *${asset}`
    );
  }
  const actual = await sha256File(archivePath);
  if (expected !== actual) {
    throw new Error("Checksum validation failed.");
  }
  console.log("Checksum validated.");
}

async function verifyChecksumFromFile(archivePath, checksumPath) {
  const checksumText = fs.readFileSync(checksumPath, "utf8");
  const lines = checksumText
    .split(/\r?\n/)
    .map((value) => value.trim())
    .filter(Boolean);

  let expected = null;
  for (const line of lines) {
    const parts = line.split(/\s+/);
    if (parts.length < 2) continue;
    const name = parts[1].replace(/^\*/, "");
    if (name === asset) {
      expected = parts[0];
      break;
    }
  }

  if (!expected) {
    throw new Error(
      `Checksum entry not found. Expected a line like: <sha256> *${asset}`
    );
  }
  const actual = await sha256File(archivePath);
  if (expected !== actual) {
    throw new Error("Checksum validation failed.");
  }
  console.log("Checksum validated.");
}

async function main() {
  fs.mkdirSync(targetDir, { recursive: true });

  console.log(`Platform: ${platform}`);
  console.log(`Architecture: ${arch}`);
  console.log(`Asset: ${asset}`);
  console.log(`URL: ${url}`);
  console.log(`Target directory: ${targetDir}`);

  if (version === "v0.0.0") {
    console.log(
      "Version is v0.0.0; skipping download. Set REPOSUITE_VERSION to install a release."
    );
    return;
  }

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "reposuite-"));
  const archivePath = path.join(tempDir, asset);

  try {
    if (assetDir) {
      const localArchive = path.join(assetDir, asset);
      const checksumPath = path.join(assetDir, "checksums.txt");
      if (!fs.existsSync(localArchive)) {
        throw new Error(`Local asset not found: ${localArchive}`);
      }
      if (!fs.existsSync(checksumPath)) {
        throw new Error(`Local checksums.txt not found: ${checksumPath}`);
      }
      console.log(`Using local asset: ${localArchive}`);
      await verifyChecksumFromFile(localArchive, checksumPath);
      console.log("Extracting archive...");
      extractArchive(localArchive);
    } else {
      console.log("Downloading release asset...");
      await downloadToFile(url, archivePath);
      await verifyChecksum(archivePath);
      console.log("Extracting archive...");
      extractArchive(archivePath);
    }

    const desiredPath = path.join(targetDir, exeName);
    let binPath = fs.existsSync(desiredPath)
      ? desiredPath
      : findFileRecursive(targetDir, exeName);

    if (!binPath) {
      throw new Error("RepoSuite binary not found after extraction.");
    }

    if (binPath !== desiredPath) {
      fs.copyFileSync(binPath, desiredPath);
      if (binPath !== desiredPath) {
        fs.unlinkSync(binPath);
      }
      binPath = desiredPath;
    }

    if (platform !== "windows") {
      fs.chmodSync(binPath, 0o755);
    }

    console.log(`Installed binary: ${binPath}`);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(`Install failed: ${error.message}`);
  process.exit(1);
});
