import {
  discoverAuthStorage,
  getAgentDir,
  ModelRegistry,
  Settings,
} from "@oh-my-pi/pi-coding-agent";
import type { AuthStorage } from "@oh-my-pi/pi-coding-agent";

/**
 * Process-wide omp services.
 *
 * The `omp` CLI builds `Settings` + `AuthStorage` + `ModelRegistry` once per
 * process and hands them to every session. omp-web serves many requests from
 * one process, so it builds them once too and re-scopes `Settings` per project
 * instead of re-opening SQLite for every route.
 *
 * Stored on `globalThis` so Next.js hot-reload does not leak a second SQLite
 * handle onto `~/.omp/agent/agent.db`.
 */

declare global {
  var __ompRuntimePromise: Promise<OmpRuntime> | undefined;
  var __ompRuntimeRefreshState: RuntimeRefreshState | undefined;
}

interface RuntimeRefreshState {
  runtime: OmpRuntime;
  promise: Promise<void>;
}

export interface OmpRuntime {
  agentDir: string;
  settings: Settings;
  authStorage: AuthStorage;
  modelRegistry: ModelRegistry;
}

async function createRuntime(): Promise<OmpRuntime> {
  const agentDir = getAgentDir();
  const settings = await Settings.init({ agentDir });
  const authStorage = await discoverAuthStorage(agentDir);
  // Pinning the registry to this exact AuthStorage keeps credential_disabled
  // events flowing to the same instance the routes read from.
  const modelRegistry = new ModelRegistry(authStorage);
  await modelRegistry.refresh("online-if-uncached");
  return { agentDir, settings, authStorage, modelRegistry };
}

async function refreshRuntimeFromDisk(runtime: OmpRuntime): Promise<void> {
  // Settings reloads its persisted layers in place, preserving runtime
  // overrides and the shared SQLite-backed AuthStorage. The registry has its
  // own mtime gate, so offline refresh only rebuilds models.yml when needed.
  await runtime.settings.reloadFromDisk();
  await runtime.modelRegistry.refresh("offline");
}

async function ensureRuntimeFresh(runtime: OmpRuntime): Promise<void> {
  const current = globalThis.__ompRuntimeRefreshState;
  if (current?.runtime === runtime) {
    await current.promise;
    return;
  }

  const promise = refreshRuntimeFromDisk(runtime);
  globalThis.__ompRuntimeRefreshState = { runtime, promise };
  try {
    await promise;
  } finally {
    if (globalThis.__ompRuntimeRefreshState?.promise === promise) {
      globalThis.__ompRuntimeRefreshState = undefined;
    }
  }
}

export async function getOmpRuntime(): Promise<OmpRuntime> {
  const wasCached = Boolean(globalThis.__ompRuntimePromise);
  globalThis.__ompRuntimePromise ??= createRuntime().catch((error) => {
    globalThis.__ompRuntimePromise = undefined;
    throw error;
  });
  const runtime = await globalThis.__ompRuntimePromise;
  // createRuntime already loaded the current files. Every later request
  // checks them again so edits made by the CLI or another process are visible
  // without restarting omp-web.
  if (wasCached) await ensureRuntimeFresh(runtime);
  return runtime;
}

/**
 * Settings scoped to `cwd`, so project-level `.omp/config.yml` overrides apply.
 *
 * Returns the shared instance when `cwd` is already the active scope; omp's
 * `cloneForCwd` reloads only the project layer, leaving global settings and
 * runtime overrides intact.
 */
export async function getSettingsForCwd(cwd: string | undefined): Promise<Settings> {
  const { settings } = await getOmpRuntime();
  if (!cwd || settings.getCwd() === cwd) return settings;
  return settings.cloneForCwd(cwd);
}

/** Drop the cached runtime so the next request rebuilds it (config/auth edits). */
export function invalidateOmpRuntime(): void {
  globalThis.__ompRuntimePromise = undefined;
  globalThis.__ompRuntimeRefreshState = undefined;
}
