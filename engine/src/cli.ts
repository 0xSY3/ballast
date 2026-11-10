import { mkdir, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { loadConfig } from "./config.ts";
import { createLiveDeps } from "./live.ts";
import { errorText } from "./net.ts";
import { emptyState, runPass } from "./run.ts";
import type { RunOutput } from "./types.ts";

const ENGINE_DIR = join(import.meta.dir, "..");
const CONFIG_DIR = join(ENGINE_DIR, "config");
const OUT_DIR = join(ENGINE_DIR, "out");
const USAGE = "usage: bun run src/cli.ts once [--at <ISO time>] | watch [--interval <seconds>]";

/** Write-then-rename so a reader never sees a half-written file. */
async function writeOutput(output: RunOutput, fileName: string): Promise<string> {
  await mkdir(OUT_DIR, { recursive: true });
  const target = join(OUT_DIR, fileName);
  const temporary = `${target}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(output, null, 2)}\n`, "utf8");
  await rename(temporary, target);
  return target;
}

function summarize(output: RunOutput, path: string): string {
  const lines = [
    `${output.runAt} ${output.replayAt ? `replay of ${output.replayAt}` : "dry-run"}: ${output.signals.length} signals, ${output.vectors.length} vectors, ` +
      `${output.orders.length} orders, ${output.skipped.length} skipped -> ${path}`,
    ...output.orders.map((order) => `  order ${order.side} ${order.quantity} ${order.ticker} ~$${order.notionalUsd}`),
    ...output.skipped.map((entry) => `  skip ${entry.reason}: ${entry.detail}`),
  ];
  return lines.join("\n");
}

function parseInterval(args: string[], fallback: number): number {
  const flagIndex = args.indexOf("--interval");
  if (flagIndex < 0) return fallback;
  const value = Number(args[flagIndex + 1]);
  if (!Number.isFinite(value) || value < 5) throw new Error("--interval must be a number of seconds >= 5");
  return value;
}

/** `--at` must name a past moment: a replay reads recorded odds, never a forecast. */
export function parseReplayAt(args: string[], now: Date): Date | null {
  const flagIndex = args.indexOf("--at");
  if (flagIndex < 0) return null;
  const text = args[flagIndex + 1];
  const at = text === undefined ? Number.NaN : Date.parse(text);
  if (text === undefined || !Number.isFinite(at)) throw new Error("--at needs an ISO time, e.g. 2026-11-10T09:30:00Z");
  if (at > now.getTime()) throw new Error(`--at ${text} is in the future`);
  return new Date(at);
}

async function runOnce(args: string[]): Promise<void> {
  const config = await loadConfig(CONFIG_DIR);
  const replayAt = parseReplayAt(args, new Date());
  const deps = createLiveDeps(config.policy, process.env);
  const { output } = await runPass(config, replayAt ? { ...deps, replayAt } : deps, emptyState());
  console.log(summarize(output, await writeOutput(output, replayAt ? "replay.json" : "latest.json")));
}

async function runWatch(args: string[]): Promise<void> {
  const config = await loadConfig(CONFIG_DIR);
  const intervalMs = parseInterval(args, config.policy.watch.intervalSeconds) * 1000;
  let stopping = false;
  let wake: () => void = () => undefined;
  const stop = () => {
    stopping = true;
    wake();
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);

  const deps = createLiveDeps(config.policy, process.env);
  let state = emptyState();
  while (!stopping) {
    const result = await runPass(config, deps, state);
    state = result.state;
    console.log(summarize(result.output, await writeOutput(result.output, "latest.json")));
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, intervalMs);
      wake = () => {
        clearTimeout(timer);
        resolve();
      };
      if (stopping) wake();
    });
  }
  console.log("watch stopped");
}

async function main(args: string[]): Promise<number> {
  const [command = "once", ...rest] = args;
  try {
    if (command === "once") await runOnce(rest);
    else if (command === "watch") await runWatch(rest);
    else {
      console.error(USAGE);
      return 2;
    }
    return 0;
  } catch (error) {
    // Only configuration and filesystem problems reach here; data problems become skipped entries.
    console.error(`ballast: ${errorText(error)}`);
    return 1;
  }
}

if (import.meta.main) {
  process.exitCode = await main(process.argv.slice(2));
}
