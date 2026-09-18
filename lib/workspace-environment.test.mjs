import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { discoverWorkspaceEnvironment, getWorkspaceEnvironmentMetrics } from "./workspace-environment.ts";

test("workspace environment maps package script names to runnable commands", async () => {
  const root = await mkdtemp(`${tmpdir()}/omp-workspace-environment-`);
  try {
    await writeFile(join(root, "package.json"), JSON.stringify({
      scripts: { test: "bun test", lint: "eslint .", typecheck: "tsc --noEmit" },
    }));
    await writeFile(join(root, "bun.lock"), "lockfileVersion = 1\n");
    const before = getWorkspaceEnvironmentMetrics();
    const environment = discoverWorkspaceEnvironment("ws_scripts", root);
    const cached = discoverWorkspaceEnvironment("ws_scripts", root);
    assert.deepEqual(environment.testCommand, ["bun", "run", "test"]);
    assert.deepEqual(environment.lintCommand, ["bun", "run", "lint"]);
    assert.deepEqual(environment.typecheckCommand, ["bun", "run", "typecheck"]);
    assert.equal(cached, environment);
    const after = getWorkspaceEnvironmentMetrics();
    assert.equal(after.discovery_count, before.discovery_count + 2);
    assert.equal(after.cache_hits, before.cache_hits + 1);
    assert.ok(after.failed_executable_probes > before.failed_executable_probes);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
