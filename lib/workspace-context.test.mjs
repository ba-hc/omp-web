import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { createWorkspaceContext, modelWithWorkspaceContext, workspaceContextHeaders } from "./workspace-context.ts";

test("workspace context is canonical and can decorate provider models", async () => {
  const root = await mkdtemp(`${tmpdir()}/omp-workspace-context-`);
  try {
    const context = await createWorkspaceContext(root, { workspaceId: "ws_explicit" });
    assert.equal(context.id, "ws_explicit");
    assert.equal(context.cwd, root);
    assert.equal(context.repoRoot, root);
    assert.equal(context.environment.workspaceId, context.id);
    assert.equal(workspaceContextHeaders(context)["x-omp-workspace-root"], root);
    const model = modelWithWorkspaceContext({ provider: "chatgpt-web", id: "model" }, context);
    assert.equal(model.headers["x-omp-workspace-id"], "ws_explicit");
    assert.equal(model.headers["x-omp-environment-id"], context.environmentId);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
