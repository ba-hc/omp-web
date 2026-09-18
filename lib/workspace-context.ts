import { createHash } from "node:crypto";
import { mkdirSync, realpathSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { discoverWorkspaceEnvironment, type WorkspaceEnvironment } from "./workspace-environment";
import { resolveProject } from "./worktree";
import { captureBranchBaseline, type BranchBaseline } from "./branch-preflight";

export interface WorkspaceContext {
  id: string;
  repoRoot: string;
  gitRoot?: string;
  cwd: string;
  trustedRoots: string[];
  writableRoots: string[];
  tempRoot: string;
  environmentId?: string;
  environment: WorkspaceEnvironment;
  branchBaseline?: BranchBaseline;
}

function canonicalPath(path: string): string {
  const resolved = resolve(path);
  try { return realpathSync(resolved); } catch { return resolved; }
}

function workspaceId(taskId: string, repoRoot: string, cwd: string): string {
  return `ws_${createHash("sha256").update(`${taskId}\0${repoRoot}\0${cwd}`).digest("hex").slice(0, 24)}`;
}

export async function createWorkspaceContext(
  cwd: string,
  options: { taskId?: string; workspaceId?: string; writableRoots?: string[] } = {},
): Promise<WorkspaceContext> {
  const canonicalCwd = canonicalPath(cwd);
  const project = await resolveProject(canonicalCwd);
  const repoRoot = canonicalPath(project.projectRoot || canonicalCwd);
  const id = options.workspaceId ?? workspaceId(options.taskId ?? "workspace", repoRoot, canonicalCwd);
  if (!/^[A-Za-z0-9_.:-]{1,256}$/.test(id)) throw new Error("workspaceId is invalid");
  const tempRoot = join(tmpdir(), "omp-workspaces", id);
  mkdirSync(tempRoot, { recursive: true, mode: 0o700 });
  const environment = discoverWorkspaceEnvironment(id, repoRoot);
  let branchBaseline: BranchBaseline | undefined;
  try { branchBaseline = await captureBranchBaseline(canonicalCwd); } catch { /* non-Git workspace */ }
  const writableRoots = (options.writableRoots ?? [canonicalCwd]).map(canonicalPath);
  return {
    id,
    repoRoot,
    ...(project.isWorktree || project.isTopLevel ? { gitRoot: repoRoot } : {}),
    cwd: canonicalCwd,
    trustedRoots: [repoRoot],
    writableRoots,
    tempRoot,
    environmentId: environment.id,
    environment,
    ...(branchBaseline ? { branchBaseline } : {}),
  };
}

export function workspaceContextHeaders(context: WorkspaceContext): Record<string, string> {
  return {
    "x-omp-workspace-id": context.id,
    "x-omp-workspace-root": context.cwd,
    "x-omp-git-root": context.gitRoot ?? context.repoRoot,
    "x-omp-trusted-roots": JSON.stringify(context.trustedRoots),
    "x-omp-writable-roots": JSON.stringify(context.writableRoots),
    ...(context.environmentId ? { "x-omp-environment-id": context.environmentId } : {}),
  };
}

export function modelWithWorkspaceContext<T extends { provider: string }>(model: T, context: WorkspaceContext): T {
  const headers = (model as T & { headers?: Record<string, string> }).headers;
  return {
    ...model,
    headers: {
      ...headers,
      ...workspaceContextHeaders(context),
    },
  } as T;
}

export function decorateModelWithWorkspaceContext(model: unknown, context: WorkspaceContext): void {
  if (!model || typeof model !== "object") return;
  const value = model as { headers?: Record<string, string> };
  value.headers = { ...value.headers, ...workspaceContextHeaders(context) };
}
