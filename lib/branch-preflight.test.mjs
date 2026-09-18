import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { promisify } from "node:util";
import { captureBranchBaseline, preflightBranchOperation } from "./branch-preflight.ts";

const execFile = promisify(execFileCallback);

async function git(cwd, ...args) {
  await execFile("git", ["-C", cwd, ...args], { env: { ...process.env, LC_ALL: "C" } });
}

test("captures a dirty branch baseline without rejecting local changes", async () => {
  const root = await mkdtemp(`${tmpdir()}/omp-branch-preflight-`);
  try {
    await git(root, "init", "-b", "main");
    await git(root, "config", "user.email", "omp-tests@example.invalid");
    await git(root, "config", "user.name", "omp tests");
    await writeFile(`${root}/tracked.txt`, "initial\n");
    await git(root, "add", "tracked.txt");
    await git(root, "commit", "-m", "initial");
    const head = (await execFile("git", ["-C", root, "rev-parse", "HEAD"])).stdout.trim();

    await writeFile(`${root}/tracked.txt`, "staged\n");
    await git(root, "add", "tracked.txt");
    await writeFile(`${root}/tracked.txt`, "unstaged\n");
    await writeFile(`${root}/untracked.txt`, "new\n");

    const baseline = await captureBranchBaseline(root);
    assert.deepEqual(baseline, {
      repoRoot: root,
      head,
      branch: "main",
      detached: false,
      stagedChanges: 1,
      unstagedChanges: 1,
      untrackedFiles: 1,
      dirty: true,
      defaultBranchCandidates: ["main"],
      mergeBase: head,
      likelyTopicBranch: false,
    });

    const preflight = await preflightBranchOperation(root, "feature/test");
    assert.equal(preflight.branch, "feature/test");
    assert.equal(preflight.baseline.head, head);
    assert.equal(preflight.requiresExplicitStack, false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("requires explicit confirmation for feature-on-feature stacking", async () => {
  const root = await mkdtemp(`${tmpdir()}/omp-branch-preflight-`);
  try {
    await git(root, "init", "-b", "feature/parent");
    await git(root, "config", "user.email", "omp-tests@example.invalid");
    await git(root, "config", "user.name", "omp tests");
    await writeFile(`${root}/tracked.txt`, "initial\n");
    await git(root, "add", "tracked.txt");
    await git(root, "commit", "-m", "initial");
    const preflight = await preflightBranchOperation(root, "feature/child");
    assert.equal(preflight.requiresExplicitStack, true);
    const confirmed = await preflightBranchOperation(root, "feature/child", { stackOnCurrent: true });
    assert.equal(confirmed.requiresExplicitStack, true);
    assert.equal(confirmed.stackOnCurrent, true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("rejects invalid branch names before a worktree mutation", async () => {
  const root = await mkdtemp(`${tmpdir()}/omp-branch-preflight-`);
  try {
    await git(root, "init");
    await assert.rejects(
      preflightBranchOperation(root, "bad..branch"),
      /invalid|not a valid (?:ref|branch name)|ambiguous/i,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
