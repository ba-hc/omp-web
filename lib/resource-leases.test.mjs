import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ResourceBusyError, ResourceLeaseManager } from "./resource-leases.ts";

test("resource leases are exclusive and release cleanly", async () => {
  const root = await mkdtemp(join(tmpdir(), "omp-resource-leases-"));
  try {
    const manager = new ResourceLeaseManager(root);
    const resource = join(root, "repo");
    const lease = manager.acquire("ws_a", "job_a", [{ resource }])[0];
    assert.throws(() => manager.acquire("ws_a", "job_b", [{ resource }]), ResourceBusyError);
    manager.release(lease);
    assert.equal(manager.acquire("ws_a", "job_b", [{ resource }]).length, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a failed multi-resource acquisition does not leak the earlier claim", async () => {
  const root = await mkdtemp(join(tmpdir(), "omp-resource-leases-"));
  try {
    const manager = new ResourceLeaseManager(root);
    const first = join(root, "first");
    const second = join(root, "second");
    const held = manager.acquire("ws_a", "job_a", [{ resource: second }])[0];
    assert.throws(() => manager.acquire("ws_a", "job_b", [{ resource: first }, { resource: second }]), ResourceBusyError);
    const recovered = manager.acquire("ws_a", "job_c", [{ resource: first }]);
    assert.equal(recovered.length, 1);
    manager.release(held);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
