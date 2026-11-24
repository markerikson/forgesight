import type { Subprocess } from "bun";

const children: Subprocess[] = [
  Bun.spawn(["bun", "run", "worker"], { stdio: ["inherit", "inherit", "inherit"] }),
  Bun.spawn(["bun", "--bun", "vite", "dev"], { stdio: ["inherit", "inherit", "inherit"] }),
];

let stopping = false;
function stopAll(code: number): void {
  if (stopping) return;
  stopping = true;
  for (const child of children) child.kill("SIGTERM");
  void Promise.all(children.map((child) => child.exited)).then(() => process.exit(code));
}

process.on("SIGINT", () => stopAll(130));
process.on("SIGTERM", () => stopAll(143));

const first = await Promise.race(children.map((child) => child.exited));
stopAll(first);
