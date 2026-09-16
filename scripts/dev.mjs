// Launch helper: runs `next dev` with this project as cwd, regardless of
// where the caller started from. Used by the Claude desktop preview.
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const child = spawn("npm", ["run", "dev"], { cwd: root, stdio: "inherit", shell: true });
child.on("exit", (code) => process.exit(code ?? 0));
