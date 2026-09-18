import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { getAgentDir } from "@oh-my-pi/pi-coding-agent";
import { writePrivateFileAtomicSync } from "./atomic-file";

export type ResourceLeaseMode = "exclusive";

export interface ResourceClaim {
  resource: string;
  mode?: ResourceLeaseMode;
  ttlMs?: number;
}

export interface ResourceLease {
  leaseId: string;
  workspaceId: string;
  ownerId: string;
  resource: string;
  mode: ResourceLeaseMode;
  acquiredAt: string;
  expiresAt: string;
}

export class ResourceBusyError extends Error {
  readonly code = "resource_busy";
  constructor(readonly conflict: ResourceLease) {
    super(`Resource is leased by ${conflict.ownerId}: ${conflict.resource}`);
  }
}

function now(): number { return Date.now(); }
function canonicalResource(resource: string): string { return resolve(resource); }

export class ResourceLeaseManager {
  private readonly root: string;

  constructor(root = join(getAgentDir(), "resource-leases")) {
    this.root = root;
    mkdirSync(root, { recursive: true, mode: 0o700 });
  }

  private lockPath(workspaceId: string, resource: string): string {
    const key = createHash("sha256").update(`${workspaceId}\0${resource}`).digest("hex");
    return join(this.root, key);
  }

  private read(path: string): ResourceLease | undefined {
    try { return JSON.parse(readFileSync(join(path, "lease.json"), "utf8")) as ResourceLease; } catch { return undefined; }
  }

  private removeExpired(path: string, timestamp = now()): ResourceLease | undefined {
    const current = this.read(path);
    if (current && Date.parse(current.expiresAt) <= timestamp) {
      rmSync(path, { recursive: true, force: true });
      return undefined;
    }
    return current;
  }

  acquire(
    workspaceId: string,
    ownerId: string,
    claims: ResourceClaim[],
    defaultTtlMs = 10 * 60_000,
  ): ResourceLease[] {
    const normalized = [...new Map(claims.map(claim => [canonicalResource(claim.resource), claim])).entries()];
    const acquired: ResourceLease[] = [];
    try {
      for (const [resource, claim] of normalized) {
        const path = this.lockPath(workspaceId, resource);
        const conflict = this.removeExpired(path);
        if (conflict) throw new ResourceBusyError(conflict);
        mkdirSync(path);
        const ttlMs = Math.max(1_000, claim.ttlMs ?? defaultTtlMs);
        const lease: ResourceLease = {
          leaseId: `lease_${randomUUID()}`,
          workspaceId,
          ownerId,
          resource,
          mode: claim.mode ?? "exclusive",
          acquiredAt: new Date().toISOString(),
          expiresAt: new Date(now() + ttlMs).toISOString(),
        };
        writePrivateFileAtomicSync(join(path, "lease.json"), `${JSON.stringify(lease, null, 2)}\n`);
        acquired.push(lease);
      }
      return acquired;
    } catch (error) {
      for (const lease of acquired) this.release(lease);
      throw error;
    }
  }

  renew(lease: ResourceLease, ttlMs = 10 * 60_000): ResourceLease {
    const path = this.lockPath(lease.workspaceId, lease.resource);
    const current = this.removeExpired(path);
    if (!current || current.leaseId !== lease.leaseId || current.ownerId !== lease.ownerId) {
      throw new Error(`Lease is no longer held: ${lease.resource}`);
    }
    const renewed = { ...current, expiresAt: new Date(now() + Math.max(1_000, ttlMs)).toISOString() };
    writePrivateFileAtomicSync(join(path, "lease.json"), `${JSON.stringify(renewed, null, 2)}\n`);
    return renewed;
  }

  release(lease: ResourceLease): void {
    const path = this.lockPath(lease.workspaceId, lease.resource);
    const current = this.read(path);
    if (current?.leaseId === lease.leaseId && current.ownerId === lease.ownerId) {
      rmSync(path, { recursive: true, force: true });
    }
  }

  releaseAll(leases: ResourceLease[] | undefined): void {
    for (const lease of leases ?? []) this.release(lease);
  }

  reapExpired(): number {
    let removed = 0;
    for (const name of readdirSync(this.root)) {
      const path = join(this.root, name);
      if (this.read(path) && !this.removeExpired(path)) removed++;
    }
    return removed;
  }
}

declare global {
  var __ompResourceLeaseManager: ResourceLeaseManager | undefined;
}

export function getResourceLeaseManager(): ResourceLeaseManager {
  globalThis.__ompResourceLeaseManager ??= new ResourceLeaseManager();
  return globalThis.__ompResourceLeaseManager;
}
