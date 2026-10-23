import { spawnSync } from "node:child_process";
import { rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
// dist is generated and ignored; old entrypoints must never survive a fresh build.
await rm(path.join(root, "dist"), { recursive: true, force: true });
const result = spawnSync(
  process.execPath,
  [path.join(root, "node_modules/typescript/bin/tsc"), "-p", "tsconfig.build.json"],
  { cwd: root, stdio: "inherit" },
);
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
