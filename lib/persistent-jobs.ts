import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { spawn, type ChildProcess } from "node:child_process";
import { join } from "node:path";
import { getAgentDir } from "@oh-my-pi/pi-coding-agent";
import { writePrivateFileAtomicSync } from "./atomic-file";
import { getResourceLeaseManager, type ResourceClaim, type ResourceLease } from "./resource-leases";
import type { WorkspaceContext } from "./workspace-context";

export type PersistentJobState = "queued" | "running" | "success" | "failed" | "cancelled" | "timed_out" | "lost";

export interface PersistentJobRecord {
  jobId: string;
  pid?: number;
  command: string;
  cwd: string;
  workspace: Pick<WorkspaceContext, "id" | "repoRoot" | "cwd" | "environmentId" | "branchBaseline">;
  state: PersistentJobState;
  startedAt: string;
  finishedAt?: string;
  exitCode?: number | null;
  signal?: string | null;
  stdoutPath: string;
  stderrPath: string;
  stdoutBytes: number;
  stderrBytes: number;
  ownerId?: string;
  timeoutMs?: number;
  inactivityTimeoutMs?: number;
  hardCeilingMs?: number;
  resourceLeases?: ResourceLease[];
}

export interface StartPersistentJobInput {
  command: string;
  cwd: string;
  env?: Record<string, string>;
  workspace: WorkspaceContext;
  ownerId?: string;
  timeoutMs?: number;
  inactivityTimeoutMs?: number;
  hardCeilingMs?: number;
  resourceClaims?: ResourceClaim[];
}

export interface JobReadResult {
  stdout: string;
  stderr: string;
  cursor: { stdout: number; stderr: number };
  state: PersistentJobState;
}

interface LiveJob {
  child: ChildProcess;
  inactivityTimer?: ReturnType<typeof setTimeout>;
  timeoutTimer?: ReturnType<typeof setTimeout>;
  hardCeilingTimer?: ReturnType<typeof setTimeout>;
  waiters: Array<() => void>;
}

declare global {
  var __ompPersistentJobManager: PersistentJobManager | undefined;
}

function now(): string { return new Date().toISOString(); }
function nowMs(): number { return Date.now(); }

function signalProcess(pid: number, signal: NodeJS.Signals): void {
  try { process.kill(-pid, signal); } catch { try { process.kill(pid, signal); } catch { /* already gone */ } }
}

function processAlive(pid: number | undefined): boolean {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
}

export class PersistentJobManager {
  private readonly root: string;
  private readonly live = new Map<string, LiveJob>();
  private readonly records = new Map<string, PersistentJobRecord>();
  private readonly resourceLeases = getResourceLeaseManager();
  private readonly leaseRenewalTimers = new Map<string, ReturnType<typeof setInterval>>();
  private initialized = false;

  constructor(root = join(getAgentDir(), "jobs")) {
    this.root = root;
  }

  initialize(): void {
    if (this.initialized) return;
    this.initialized = true;
    mkdirSync(this.root, { recursive: true, mode: 0o700 });
    for (const name of readdirSync(this.root)) {
      if (!name.endsWith(".json")) continue;
      try {
        const record = JSON.parse(readFileSync(join(this.root, name), "utf8")) as PersistentJobRecord;
        if (!record.jobId || !record.state) continue;
        if (record.state === "running" || record.state === "queued") {
          if (this.reconcileFinished(record)) {
            // A detached supervisor records the exit code across manager restarts.
          } else if (!processAlive(record.pid)) {
            record.state = "lost";
            record.finishedAt = now();
            this.save(record);
            this.resourceLeases.releaseAll(record.resourceLeases);
          } else {
            this.scheduleLeaseRenewal(record);
          }
        } else {
          this.resourceLeases.releaseAll(record.resourceLeases);
        }
        this.records.set(record.jobId, record);
      } catch {
        // Ignore an incomplete atomic write; it cannot be a valid recoverable job.
      }
    }
  }

  private save(record: PersistentJobRecord): void {
    this.records.set(record.jobId, record);
    writePrivateFileAtomicSync(join(this.root, `${record.jobId}.json`), `${JSON.stringify(record, null, 2)}\n`);
  }

  private resultPath(jobId: string): string {
    return join(this.root, `${jobId}.result`);
  }

  private reconcileFinished(record: PersistentJobRecord): boolean {
    try {
      const exitCode = Number.parseInt(readFileSync(this.resultPath(record.jobId), "utf8").trim(), 10);
      if (!Number.isInteger(exitCode)) return false;
      record.state = exitCode === 0 ? "success" : "failed";
      record.finishedAt = now();
      record.exitCode = exitCode;
      record.signal = null;
      this.save(record);
      this.resourceLeases.releaseAll(record.resourceLeases);
      this.clearLeaseRenewal(record.jobId);
      return true;
    } catch {
      return false;
    }
  }

  private record(jobId: string): PersistentJobRecord {
    this.initialize();
    const record = this.records.get(jobId);
    if (!record) throw new Error(`Job not found: ${jobId}`);
    return record;
  }

  start(input: StartPersistentJobInput): PersistentJobRecord {
    this.initialize();
    const jobId = `job_${randomUUID()}`;
    const stdoutPath = join(this.root, `${jobId}.stdout.log`);
    const stderrPath = join(this.root, `${jobId}.stderr.log`);
    const record: PersistentJobRecord = {
      jobId,
      command: input.command,
      cwd: input.cwd,
      workspace: {
        id: input.workspace.id,
        repoRoot: input.workspace.repoRoot,
        cwd: input.workspace.cwd,
        ...(input.workspace.environmentId ? { environmentId: input.workspace.environmentId } : {}),
        ...(input.workspace.branchBaseline ? { branchBaseline: input.workspace.branchBaseline } : {}),
      },
      state: "queued",
      startedAt: now(),
      stdoutPath,
      stderrPath,
      stdoutBytes: 0,
      stderrBytes: 0,
      ...(input.ownerId ? { ownerId: input.ownerId } : {}),
      ...(input.timeoutMs ? { timeoutMs: input.timeoutMs } : {}),
      ...(input.inactivityTimeoutMs ? { inactivityTimeoutMs: input.inactivityTimeoutMs } : {}),
      ...(input.hardCeilingMs ? { hardCeilingMs: input.hardCeilingMs } : {}),
    };
    const resourceLeases = input.resourceClaims?.length
      ? this.resourceLeases.acquire(input.workspace.id, input.ownerId ?? jobId, input.resourceClaims)
      : [];
    if (resourceLeases.length > 0) record.resourceLeases = resourceLeases;
    writeFileSync(stdoutPath, "", { mode: 0o600 });
    writeFileSync(stderrPath, "", { mode: 0o600 });
    this.save(record);

    const child = spawn("/bin/sh", ["-lc", [
      "umask 077",
      "/bin/sh -lc \"$OMP_PERSISTENT_JOB_COMMAND\"",
      "status=$?",
      "printf \"%s\\n\" \"$status\" > \"$OMP_PERSISTENT_JOB_RESULT\"",
      "exit \"$status\"",
    ].join("; ")], {
      cwd: input.cwd,
      env: {
        ...process.env,
        ...input.env,
        OMP_WORKSPACE_ID: input.workspace.id,
        OMP_PERSISTENT_JOB_COMMAND: input.command,
        OMP_PERSISTENT_JOB_RESULT: this.resultPath(jobId),
      },
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    record.pid = child.pid;
    record.state = "running";
    this.save(record);
    const live: LiveJob = { child, waiters: [] };
    this.live.set(jobId, live);
    this.scheduleLeaseRenewal(record);
    const touch = (kind: "stdoutBytes" | "stderrBytes", chunk: Buffer): void => {
      record[kind] += chunk.byteLength;
      this.save(record);
      this.resetInactivity(jobId, input.inactivityTimeoutMs);
    };
    child.stdout?.on("data", chunk => {
      writeFileSync(stdoutPath, chunk, { flag: "a", mode: 0o600 });
      touch("stdoutBytes", chunk);
    });
    child.stderr?.on("data", chunk => {
      writeFileSync(stderrPath, chunk, { flag: "a", mode: 0o600 });
      touch("stderrBytes", chunk);
    });
    child.once("error", error => this.finish(jobId, "failed", null, error.name));
    child.once("close", (code, signal) => {
      const state = record.state === "cancelled" ? "cancelled" : code === 0 ? "success" : "failed";
      this.finish(jobId, state, code, signal);
    });
    if (input.timeoutMs) live.timeoutTimer = setTimeout(() => this.timeout(jobId, "timed_out"), input.timeoutMs);
    if (input.hardCeilingMs) live.hardCeilingTimer = setTimeout(() => this.timeout(jobId, "timed_out"), input.hardCeilingMs);
    this.resetInactivity(jobId, input.inactivityTimeoutMs);
    return { ...record };
  }

  private resetInactivity(jobId: string, timeoutMs?: number): void {
    if (!timeoutMs) return;
    const live = this.live.get(jobId);
    if (!live) return;
    if (live.inactivityTimer) clearTimeout(live.inactivityTimer);
    live.inactivityTimer = setTimeout(() => this.timeout(jobId, "timed_out"), timeoutMs);
  }

  private timeout(jobId: string, state: "timed_out"): void {
    const record = this.record(jobId);
    if (record.state !== "running") return;
    record.state = state;
    this.save(record);
    if (record.pid) signalProcess(record.pid, "SIGTERM");
  }

  private finish(jobId: string, state: PersistentJobState, exitCode: number | null, signal: string | null): void {
    const record = this.record(jobId);
    try {
      const persisted = JSON.parse(readFileSync(join(this.root, `${jobId}.json`), "utf8")) as PersistentJobRecord;
      if (["cancelled", "timed_out", "success", "failed", "lost"].includes(persisted.state)) {
        Object.assign(record, persisted);
      }
    } catch {
      // Keep the in-memory record if the atomic state file is temporarily unavailable.
    }
    if (record.state === "success" || record.state === "failed" || record.state === "lost") {
      this.clearLeaseRenewal(jobId);
      this.resourceLeases.releaseAll(record.resourceLeases);
      return;
    }
    record.state = record.state === "timed_out" ? "timed_out" : state;
    record.finishedAt = now();
    record.exitCode = exitCode;
    record.signal = signal;
    this.save(record);
    const live = this.live.get(jobId);
    if (live) {
      for (const waiter of live.waiters.splice(0)) waiter();
      if (live.inactivityTimer) clearTimeout(live.inactivityTimer);
      if (live.timeoutTimer) clearTimeout(live.timeoutTimer);
      if (live.hardCeilingTimer) clearTimeout(live.hardCeilingTimer);
      this.live.delete(jobId);
    }
    this.resourceLeases.releaseAll(record.resourceLeases);
    this.clearLeaseRenewal(jobId);
  }

  private scheduleLeaseRenewal(record: PersistentJobRecord): void {
    if (!record.resourceLeases?.length || this.leaseRenewalTimers.has(record.jobId)) return;
    const timer = setInterval(() => {
      const current = this.records.get(record.jobId);
      if (!current || !["queued", "running"].includes(current.state)) {
        this.clearLeaseRenewal(record.jobId);
        return;
      }
      try {
        current.resourceLeases = current.resourceLeases?.map(lease => this.resourceLeases.renew(lease));
        this.save(current);
      } catch {
        current.state = "timed_out";
        current.finishedAt = now();
        this.save(current);
        if (current.pid) signalProcess(current.pid, "SIGTERM");
        this.clearLeaseRenewal(record.jobId);
      }
    }, 5 * 60_000);
    timer.unref?.();
    this.leaseRenewalTimers.set(record.jobId, timer);
  }

  private clearLeaseRenewal(jobId: string): void {
    const timer = this.leaseRenewalTimers.get(jobId);
    if (!timer) return;
    clearInterval(timer);
    this.leaseRenewalTimers.delete(jobId);
  }

  status(jobId: string): PersistentJobRecord { return { ...this.record(jobId) }; }

  read(jobId: string, cursor: { stdout?: number; stderr?: number } = {}): JobReadResult {
    const record = this.record(jobId);
    const stdoutOffset = Math.max(0, cursor.stdout ?? 0);
    const stderrOffset = Math.max(0, cursor.stderr ?? 0);
    const stdout = this.readFrom(record.stdoutPath, stdoutOffset);
    const stderr = this.readFrom(record.stderrPath, stderrOffset);
    return {
      stdout: stdout.text,
      stderr: stderr.text,
      cursor: { stdout: stdout.next, stderr: stderr.next },
      state: record.state,
    };
  }

  private readFrom(path: string, offset: number): { text: string; next: number } {
    if (!existsSync(path)) return { text: "", next: offset };
    const size = statSync(path).size;
    if (offset >= size) return { text: "", next: size };
    const contents = readFileSync(path);
    return { text: contents.subarray(offset).toString("utf8"), next: contents.byteLength };
  }

  async wait(jobId: string, timeoutMs = 30_000): Promise<PersistentJobRecord> {
    const record = this.record(jobId);
    if (!["queued", "running"].includes(record.state)) return { ...record };
    const live = this.live.get(jobId);
    if (!live) {
      const deadline = nowMs() + Math.max(0, timeoutMs);
      while (processAlive(record.pid) && nowMs() < deadline) {
        await new Promise(resolve => setTimeout(resolve, Math.min(100, Math.max(1, deadline - nowMs()))));
      }
      if (!processAlive(record.pid) && ["queued", "running"].includes(record.state) && !this.reconcileFinished(record)) {
        record.state = "lost";
        record.finishedAt = now();
        this.save(record);
        this.resourceLeases.releaseAll(record.resourceLeases);
        this.clearLeaseRenewal(jobId);
      }
      return { ...record };
    }
    await new Promise<void>(resolve => {
      const timer = setTimeout(resolve, Math.max(0, timeoutMs));
      live.waiters.push(() => { clearTimeout(timer); resolve(); });
    });
    return this.status(jobId);
  }

  cancel(jobId: string): PersistentJobRecord {
    const record = this.record(jobId);
    if (!["queued", "running"].includes(record.state)) return { ...record };
    record.state = "cancelled";
    this.save(record);
    if (record.pid) signalProcess(record.pid, "SIGTERM");
    return { ...record };
  }
}

export function getPersistentJobManager(): PersistentJobManager {
  globalThis.__ompPersistentJobManager ??= new PersistentJobManager();
  globalThis.__ompPersistentJobManager.initialize();
  return globalThis.__ompPersistentJobManager;
}
