import { execFile } from "child_process";
import { promisify } from "util";

const execFileAsync = promisify(execFile);

export interface BranchBaseline {
  repoRoot: string;
  head: string;
  branch: string | null;
  detached: boolean;
  stagedChanges: number;
  unstagedChanges: number;
  untrackedFiles: number;
  dirty: boolean;
  upstream?: string;
  defaultRemoteBranch?: string;
  defaultBranchCandidates: string[];
  mergeBase?: string;
  ahead?: number;
  behind?: number;
  likelyTopicBranch: boolean;
}

export interface BranchPreflight {
  branch: string;
  baseline: BranchBaseline;
  stackOnCurrent: boolean;
  requiresExplicitStack: boolean;
}

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", ["-C", cwd, ...args], {
    timeout: 10_000,
    maxBuffer: 1024 * 1024,
    env: { ...process.env, LC_ALL: "C" },
  });
  return stdout.trim();
}

async function gitMaybe(cwd: string, args: string[]): Promise<string | undefined> {
  try { return await git(cwd, args); } catch { return undefined; }
}

function countStatusChanges(status: string): Pick<BranchBaseline, "stagedChanges" | "unstagedChanges" | "untrackedFiles"> {
  const lines = status ? status.split("\n") : [];
  let stagedChanges = 0;
  let unstagedChanges = 0;
  let untrackedFiles = 0;
  for (const line of lines) {
    if (line.startsWith("??")) {
      untrackedFiles += 1;
      continue;
    }
    if (line[0] && line[0] !== " ") stagedChanges += 1;
    if (line[1] && line[1] !== " ") unstagedChanges += 1;
  }
  return { stagedChanges, unstagedChanges, untrackedFiles };
}

export async function captureBranchBaseline(cwd: string): Promise<BranchBaseline> {
  const [repoRoot, head, branchOutput, status, upstream, defaultRemoteBranch, localBranches] = await Promise.all([
    git(cwd, ["rev-parse", "--show-toplevel"]),
    git(cwd, ["rev-parse", "HEAD"]),
    git(cwd, ["symbolic-ref", "--quiet", "--short", "HEAD"]).catch(() => ""),
    git(cwd, ["status", "--porcelain=v1", "--untracked-files=all"]),
    gitMaybe(cwd, ["rev-parse", "--abbrev-ref", "@{upstream}"]),
    gitMaybe(cwd, ["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"]),
    git(cwd, ["for-each-ref", "refs/heads", "--format=%(refname:short)"]),
  ]);
  const counts = countStatusChanges(status);
  const branch = branchOutput || null;
  const defaultCandidates = ["main", "master", "develop", ...(defaultRemoteBranch ? [defaultRemoteBranch.replace(/^origin\//, "")] : [])]
    .filter((candidate, index, all) => all.indexOf(candidate) === index && localBranches.split("\n").includes(candidate));
  const defaultBranch = defaultCandidates[0];
  const mergeBase = defaultBranch ? await gitMaybe(cwd, ["merge-base", "HEAD", defaultBranch]) : undefined;
  let ahead: number | undefined;
  let behind: number | undefined;
  if (upstream) {
    const countsOutput = await gitMaybe(cwd, ["rev-list", "--left-right", "--count", `HEAD...${upstream}`]);
    const match = countsOutput?.match(/^(\d+)\s+(\d+)$/);
    if (match) { ahead = Number(match[1]); behind = Number(match[2]); }
  }
  return {
    repoRoot,
    head,
    branch,
    detached: branch === null,
    ...counts,
    dirty: status.length > 0,
    ...(upstream ? { upstream } : {}),
    ...(defaultRemoteBranch ? { defaultRemoteBranch } : {}),
    defaultBranchCandidates: defaultCandidates,
    ...(mergeBase ? { mergeBase } : {}),
    ...(ahead !== undefined ? { ahead } : {}),
    ...(behind !== undefined ? { behind } : {}),
    likelyTopicBranch: branch !== null && !defaultCandidates.includes(branch) && /[/-]/.test(branch),
  };
}

/**
 * Capture an advisory baseline immediately before an explicit branch/worktree
 * operation. Dirty state is reported, never rejected; Git remains authoritative.
 */
export async function preflightBranchOperation(
  cwd: string,
  branch: string,
  options: { stackOnCurrent?: boolean } = {},
): Promise<BranchPreflight> {
  const trimmed = branch.trim();
  if (!trimmed) throw new Error("Branch name is required");
  await git(cwd, ["check-ref-format", "--branch", trimmed]);
  const baseline = await captureBranchBaseline(cwd);
  const requestedTopic = !["main", "master", "develop"].includes(trimmed) && /[/-]/.test(trimmed);
  const requiresExplicitStack = baseline.likelyTopicBranch && requestedTopic && baseline.branch !== trimmed;
  const stackOnCurrent = options.stackOnCurrent === true;
  return { branch: trimmed, baseline, stackOnCurrent, requiresExplicitStack };
}
