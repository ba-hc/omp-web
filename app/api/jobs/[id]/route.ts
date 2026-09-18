import { NextResponse } from "next/server";
import { hasJsonContentType, isApiRequestAllowed } from "@/lib/request-security";
import { getPersistentJobManager } from "@/lib/persistent-jobs";

type Params = { params: Promise<{ id: string }> };

export async function GET(req: Request, { params }: Params) {
  if (!isApiRequestAllowed(req)) return NextResponse.json({ error: "Untrusted API request" }, { status: 403 });
  try {
    const { id } = await params;
    const query = new URL(req.url).searchParams;
    const op = query.get("op") ?? "status";
    const jobs = getPersistentJobManager();
    if (op === "read") {
      return NextResponse.json(jobs.read(id, {
        stdout: Number(query.get("stdout") ?? 0),
        stderr: Number(query.get("stderr") ?? 0),
      }));
    }
    if (op === "wait") return NextResponse.json(await jobs.wait(id, Math.max(0, Number(query.get("timeoutMs") ?? 30_000))));
    if (op !== "status") return NextResponse.json({ error: "op must be status, read, or wait" }, { status: 400 });
    return NextResponse.json(jobs.status(id));
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : String(error) }, { status: 404 });
  }
}

export async function POST(req: Request, { params }: Params) {
  if (!isApiRequestAllowed(req)) return NextResponse.json({ error: "Untrusted API request" }, { status: 403 });
  if (!hasJsonContentType(req)) return NextResponse.json({ error: "Content-Type must be application/json" }, { status: 415 });
  try {
    const { id } = await params;
    const body = await req.json() as { op?: string; timeoutMs?: number; stdout?: number; stderr?: number };
    const jobs = getPersistentJobManager();
    if (body.op === "cancel") return NextResponse.json(jobs.cancel(id));
    if (body.op === "wait") return NextResponse.json(await jobs.wait(id, body.timeoutMs ?? 30_000));
    if (body.op === "read") return NextResponse.json(jobs.read(id, { stdout: body.stdout, stderr: body.stderr }));
    return NextResponse.json({ error: "op must be cancel, wait, or read" }, { status: 400 });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : String(error) }, { status: 404 });
  }
}
