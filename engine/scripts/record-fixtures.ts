/**
 * Runs one live pass and saves every API response it read, so tests can replay that exact
 * moment offline. Usage: bun run scripts/record-fixtures.ts <fixture-name>
 */
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { loadConfig } from "../src/config.ts";
import { createLiveDeps } from "../src/live.ts";
import { createLiveFetcher, type JsonFetcher } from "../src/net.ts";
import { emptyState, runPass } from "../src/run.ts";
import { fixtureFileName, fixtureKey, type FixtureManifest } from "../test/support/replay.ts";

const ENGINE_DIR = join(import.meta.dir, "..");
const name = process.argv[2];
if (!name || !/^[a-z0-9-]+$/.test(name)) {
  console.error("usage: bun run scripts/record-fixtures.ts <fixture-name in kebab-case>");
  process.exit(2);
}

const directory = join(ENGINE_DIR, "test", "fixtures", name);
await rm(directory, { recursive: true, force: true });
await mkdir(directory, { recursive: true });

const config = await loadConfig(join(ENGINE_DIR, "config"));
const live = createLiveFetcher(config.policy.network);
const responses: Record<string, string> = {};
const recording: JsonFetcher = async (url) => {
  const result = await live(url);
  if (result.ok) {
    const key = fixtureKey(url);
    const file = fixtureFileName(key);
    responses[key] = file;
    await writeFile(join(directory, file), JSON.stringify(result.data), "utf8");
  }
  return result;
};

const now = new Date();
const deps = { ...createLiveDeps(config.policy, {}, recording), now: () => now };
const { output } = await runPass(config, deps, emptyState());

const manifest: FixtureManifest = {
  recordedAt: now.toISOString(),
  note: "Public API responses recorded by scripts/record-fixtures.ts; replayed by tests at recordedAt.",
  responses,
};
await writeFile(join(directory, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
await writeFile(join(directory, "expected-output.json"), `${JSON.stringify(output, null, 2)}\n`, "utf8");
console.log(`recorded ${Object.keys(responses).length} responses at ${manifest.recordedAt} into ${directory}`);
console.log(`signals ${output.signals.length}, vectors ${output.vectors.length}, skipped ${output.skipped.length}`);
