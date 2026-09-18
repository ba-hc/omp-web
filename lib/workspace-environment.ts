import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

export interface WorkspaceEnvironment {
  id: string;
  workspaceId: string;
  python?: string;
  pytest?: string[];
  node?: string;
  bun?: string;
  packageManager?: string;
  testCommand?: string[];
  lintCommand?: string[];
  typecheckCommand?: string[];
  discoveredFrom: string[];
  fingerprint: string;
}

export interface WorkspaceEnvironmentMetrics {
  discovery_count: number;
  cache_hits: number;
  failed_executable_probes: number;
}

declare global {
  var __ompWorkspaceEnvironmentCache: Map<string, WorkspaceEnvironment> | undefined;
  var __ompWorkspaceEnvironmentMetrics: WorkspaceEnvironmentMetrics | undefined;
}

function executable(path: string): string | undefined {
  try {
    if (existsSync(path) && statSync(path).isFile()) return path;
  } catch {
    // Count failed probes below so discovery diagnostics explain missing tools.
  }
  const metrics = globalThis.__ompWorkspaceEnvironmentMetrics ??= {
    discovery_count: 0,
    cache_hits: 0,
    failed_executable_probes: 0,
  };
  metrics.failed_executable_probes += 1;
  return undefined;
}

function packageScripts(repoRoot: string): Record<string, string> {
  try {
    const parsed = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8")) as { scripts?: unknown };
    const scripts = parsed.scripts;
    if (!scripts || typeof scripts !== "object" || Array.isArray(scripts)) return {};
    return Object.fromEntries(Object.entries(scripts).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
  } catch {
    return {};
  }
}

function commandForScript(packageManager: string | undefined, scriptName: string | undefined): string[] | undefined {
  if (!scriptName) return undefined;
  if (packageManager === "bun") return ["bun", "run", scriptName];
  if (packageManager === "pnpm") return ["pnpm", scriptName];
  if (packageManager === "yarn") return ["yarn", scriptName];
  return ["npm", "run", scriptName];
}

function firstScriptName(scripts: Record<string, string>, names: string[]): string | undefined {
  return names.find(name => scripts[name] !== undefined);
}

function readPackageManager(repoRoot: string): string | undefined {
  try {
    const parsed = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8")) as { packageManager?: unknown };
    if (typeof parsed.packageManager === "string") return parsed.packageManager.split("@", 1)[0];
  } catch {
    // Fall through to lockfile detection.
  }
  if (existsSync(join(repoRoot, "bun.lock")) || existsSync(join(repoRoot, "bun.lockb"))) return "bun";
  if (existsSync(join(repoRoot, "pnpm-lock.yaml"))) return "pnpm";
  if (existsSync(join(repoRoot, "yarn.lock"))) return "yarn";
  if (existsSync(join(repoRoot, "package-lock.json"))) return "npm";
  return undefined;
}

function fingerprintInputs(repoRoot: string): string[] {
  return [
    "pyproject.toml", "requirements.txt", "requirements-dev.txt", "poetry.lock", "uv.lock",
    "package.json", "bun.lock", "bun.lockb", "package-lock.json", "pnpm-lock.yaml", "yarn.lock",
    "Makefile", "justfile", "tox.ini", "noxfile.py",
  ].filter(name => existsSync(join(repoRoot, name)));
}

function fingerprint(repoRoot: string, inputs: string[]): string {
  const hash = createHash("sha256");
  hash.update(repoRoot);
  for (const input of inputs) {
    const path = join(repoRoot, input);
    try {
      const stat = statSync(path);
      hash.update(`${input}:${stat.size}:${stat.mtimeMs}`);
    } catch {
      hash.update(`${input}:missing`);
    }
  }
  return hash.digest("hex").slice(0, 24);
}

export function discoverWorkspaceEnvironment(workspaceId: string, repoRoot: string): WorkspaceEnvironment {
  const inputs = fingerprintInputs(repoRoot);
  const key = `${workspaceId}:${repoRoot}:${fingerprint(repoRoot, inputs)}`;
  const cache = globalThis.__ompWorkspaceEnvironmentCache ??= new Map();
  const metrics = globalThis.__ompWorkspaceEnvironmentMetrics ??= {
    discovery_count: 0,
    cache_hits: 0,
    failed_executable_probes: 0,
  };
  metrics.discovery_count += 1;
  const existing = cache.get(key);
  if (existing) {
    metrics.cache_hits += 1;
    return existing;
  }

  const venvPython = [
    join(repoRoot, ".venv", "bin", "python"),
    join(repoRoot, "venv", "bin", "python"),
  ].map(executable).find(Boolean);
  const pytest = venvPython ? [venvPython, "-m", "pytest"] : undefined;
  const bun = executable(join(repoRoot, "node_modules", ".bin", "bun")) ?? process.env.OMP_WEB_BUN;
  const node = process.execPath;
  const packageManager = readPackageManager(repoRoot);
  const scripts = packageScripts(repoRoot);
  const testScript = firstScriptName(scripts, ["test", "test:unit", "check"]);
  const lintScript = firstScriptName(scripts, ["lint"]);
  const typecheckScript = firstScriptName(scripts, ["typecheck", "check:types"]);
  const environment: WorkspaceEnvironment = {
    id: `env_${fingerprint(repoRoot, inputs)}`,
    workspaceId,
    ...(venvPython ? { python: venvPython } : {}),
    ...(pytest ? { pytest } : {}),
    ...(node ? { node } : {}),
    ...(bun ? { bun } : {}),
    ...(packageManager ? { packageManager } : {}),
    ...(commandForScript(packageManager, testScript) ? {
      testCommand: commandForScript(packageManager, testScript),
    } : {}),
    ...(commandForScript(packageManager, lintScript) ? { lintCommand: commandForScript(packageManager, lintScript) } : {}),
    ...(commandForScript(packageManager, typecheckScript) ? {
      typecheckCommand: commandForScript(packageManager, typecheckScript),
    } : {}),
    discoveredFrom: inputs,
    fingerprint: fingerprint(repoRoot, inputs),
  };
  cache.set(key, environment);
  return environment;
}

export function getWorkspaceEnvironmentMetrics(): WorkspaceEnvironmentMetrics {
  return { ...(globalThis.__ompWorkspaceEnvironmentMetrics ?? {
    discovery_count: 0,
    cache_hits: 0,
    failed_executable_probes: 0,
  }) };
}
