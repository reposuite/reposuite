const { spawnSync } = require("child_process");
const path = require("path");

const result = spawnSync("node", [path.join(__dirname, "install.js")], {
  stdio: "inherit",
  env: { ...process.env, REPOSUITE_VERSION: "v0.0.0" },
});

process.exit(result.status === null ? 1 : result.status);
