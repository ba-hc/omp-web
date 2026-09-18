import { NextResponse } from "next/server";
import { getAllowedFileRoots, isExistingFilePathAllowed, isFilePathAllowed } from "@/lib/file-access";
import { hasJsonContentType, isApiRequestAllowed } from "@/lib/request-security";
import { getPersistentJobManager } from "@/lib/persistent-jobs";
import { ResourceBusyError, type ResourceClaim } from "@/lib/resource-leases";
import { createWorkspaceContext } from "@/lib/workspace-context";

export async function POST(req: Request) {
  if (!isApiRequestAllowed(req)) return NextResponse.json({ error: "Untrusted API request" }, { status: 403 });
  if (!hasJsonContentType(req)) return NextResponse.json({ error: "Content-Type must be application/json" }, { status: 415 });
  try {
    const body = await req.json() as {
      command?: string;
      cwd?: string;
      env?: Record<string, string>;
      workspaceId?: string;
      ownerId?: string;
      timeoutMs?: number;
      inactivityTimeoutMs?: number;
      hardCeilingMs?: number;
      resourceClaims?: ResourceClaim[];
    };
    if (!body.command?.trim()) return NextResponse.json({ error: "command is required" }, { status: 400 });
    if (!body.cwd?.trim()) return NextResponse.json({ error: "cwd is required" }, { status: 400 });
    const roots = await getAllowedFileRoots();
    if (!isFilePathAllowed(body.cwd, roots) || !isExistingFilePathAllowed(body.cwd, roots)) {
      return NextResponse.json({ error: "Access denied" }, { status: 403 });
    }
    if (body.env !== undefined && (
      typeof body.env !== "object"
      || Array.isArray(body.env)
      || Object.entries(body.env).some(([key, value]) => !/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || typeof value !== "string")
    )) {
      return NextResponse.json({ error: "env must contain valid string environment variables" }, { status: 400 });
    }
    if (body.resourceClaims !== undefined && (
      !Array.isArray(body.resourceClaims)
      || body.resourceClaims.some(claim => (
        !claim
        || typeof claim.resource !== "string"
        || !claim.resource.trim()
        || (claim.mode !== undefined && claim.mode !== "exclusive")
        || (claim.ttlMs !== undefined && (!Number.isFinite(claim.ttlMs) || claim.ttlMs < 1_000))
      ))
    )) {
      return NextResponse.json({ error: "resourceClaims must contain resource paths" }, { status: 400 });
    }
    const workspace = await createWorkspaceContext(body.cwd, {
      workspaceId: body.workspaceId,
      taskId: body.ownerId ?? "job",
    });
    const record = getPersistentJobManager().start({
      command: body.command,
      cwd: workspace.cwd,
      env: body.env,
      workspace,
      ownerId: body.ownerId,
      timeoutMs: body.timeoutMs,
      inactivityTimeoutMs: body.inactivityTimeoutMs,
      hardCeilingMs: body.hardCeilingMs,
      resourceClaims: body.resourceClaims,
    });
    return NextResponse.json(record, { status: 202 });
  } catch (error) {
    if (error instanceof ResourceBusyError) {
      return NextResponse.json({ error: error.message, code: error.code, conflict: error.conflict }, { status: 409 });
    }
    return NextResponse.json({ error: error instanceof Error ? error.message : String(error) }, { status: 400 });
  }
}
