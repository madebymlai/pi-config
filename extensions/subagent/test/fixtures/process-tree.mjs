import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";

if (process.argv[2] === "descendant") {
  process.on("SIGTERM", () => {});
  setInterval(() => {}, 1_000);
} else {
  const descendant = spawn(process.execPath, [process.argv[1], "descendant"], { stdio: "ignore" });
  setTimeout(() => {
    if (process.env.PROCESS_TREE_PID_FILE)
      writeFileSync(process.env.PROCESS_TREE_PID_FILE, `${descendant.pid}\n`);
    process.stdout.write(`${descendant.pid}\n`);
  }, 25);
  process.on("SIGTERM", () => process.exit(0));
  setInterval(() => {}, 1_000);
}
