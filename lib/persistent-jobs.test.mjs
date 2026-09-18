import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { PersistentJobManager } from "./persistent-jobs.ts";
import { getResourceLeaseManager } from "./resource-leases.ts";

function workspace(root) {
  return {
    id: "ws_test",
    repoRoot: root,
    cwd: root,
    tempRoot: root,
    environment: { id: "env_test", workspaceId: "ws_test", discoveredFrom: [], fingerprint: "test" },
  };
}

test("persistent jobs return immediately and expose cursor-based output", async () => {
  const root = await mkdtemp(`${tmpdir()}/omp-persistent-job-`);
  try {
    const manager = new PersistentJobManager(root);
    const started = manager.start({ command: "printf first; sleep 0.05; printf second", cwd: root, workspace: workspace(root) });
    assert.equal(started.state, "running");
    const finished = await manager.wait(started.jobId, 2_000);
    assert.equal(finished.state, "success");
    const first = manager.read(started.jobId);
    assert.equal(first.stdout, "firstsecond");
    const second = manager.read(started.jobId, first.cursor);
    assert.equal(second.stdout, "");
    assert.deepEqual(second.cursor, first.cursor);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a recovered manager keeps a live PID controllable after transport loss", async () => {
  const root = await mkdtemp(`${tmpdir()}/omp-persistent-job-`);
  try {
    const first = new PersistentJobManager(root);
    const started = first.start({ command: "sleep 5", cwd: root, workspace: workspace(root) });
    const recovered = new PersistentJobManager(root);
    const status = recovered.status(started.jobId);
    assert.equal(status.state, "running");
    assert.equal(recovered.cancel(started.jobId).state, "cancelled");
    await new Promise(resolve => setTimeout(resolve, 100));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a recovered manager observes a completed detached job", async () => {
  const root = await mkdtemp(`${tmpdir()}/omp-persistent-job-`);
  try {
    const first = new PersistentJobManager(root);
    const started = first.start({ command: "sleep 0.1; printf recovered", cwd: root, workspace: workspace(root) });
    const recovered = new PersistentJobManager(root);
    const finished = await recovered.wait(started.jobId, 2_000);
    assert.equal(finished.state, "success");
    assert.equal(recovered.read(started.jobId).stdout, "recovered");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("process timeout is distinct from an RPC wait timeout", async () => {
  const root = await mkdtemp(`${tmpdir()}/omp-persistent-job-`);
  try {
    const manager = new PersistentJobManager(root);
    const started = manager.start({ command: "sleep 1", cwd: root, workspace: workspace(root), timeoutMs: 30 });
    const waited = await manager.wait(started.jobId, 500);
    assert.equal(waited.state, "timed_out");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("successful jobs release their workspace resource leases", async () => {
  const root = await mkdtemp(`${tmpdir()}/omp-persistent-job-`);
  try {
    const manager = new PersistentJobManager(root);
    const resource = `${root}/repo`;
    const started = manager.start({
      command: "true",
      cwd: root,
      workspace: workspace(root),
      resourceClaims: [{ resource }],
    });
    assert.equal((await manager.wait(started.jobId, 2_000)).state, "success");
    const lease = getResourceLeaseManager().acquire("ws_test", "after_job", [{ resource }])[0];
    getResourceLeaseManager().release(lease);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
