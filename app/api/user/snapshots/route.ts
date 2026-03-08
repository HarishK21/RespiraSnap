import type { SessionAnalysis } from "@/lib/analysisBundle";
import { requireAuthenticatedUser } from "@/lib/server/auth";
import { listSnapshotsForUser, persistSnapshotForUser } from "@/lib/server/userStore";

type PersistSnapshotBody = {
  analysis?: SessionAnalysis;
  deviceId?: string;
  source?: "record" | "upload" | null;
  fileName?: string;
  audioBase64?: string;
  audioMimeType?: string;
  audioFileName?: string;
};

function jsonResponse(payload: unknown, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      "content-type": "application/json"
    }
  });
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function looksLikeSessionAnalysis(value: unknown): value is SessionAnalysis {
  if (!isObject(value)) return false;
  if (typeof value.createdAt !== "string") return false;
  if (typeof value.score !== "number") return false;
  if (!isObject(value.waveform)) return false;
  if (!Array.isArray(value.markers)) return false;
  return true;
}

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const user = await requireAuthenticatedUser();
    const { searchParams } = new URL(request.url);
    const limit = Number(searchParams.get("limit") ?? "20");
    const snapshots = await listSnapshotsForUser(user.id, Number.isFinite(limit) ? limit : 20);

    return jsonResponse({
      snapshots
    });
  } catch (error) {
    if (error instanceof Error && error.message === "UNAUTHORIZED") {
      return jsonResponse({ error: "Unauthorized" }, 401);
    }
    return jsonResponse({ error: "Unable to fetch snapshots." }, 500);
  }
}

export async function POST(request: Request) {
  let body: PersistSnapshotBody;
  try {
    body = (await request.json()) as PersistSnapshotBody;
  } catch {
    return jsonResponse({ error: "Invalid JSON payload." }, 400);
  }

  if (!looksLikeSessionAnalysis(body.analysis)) {
    return jsonResponse({ error: "Invalid analysis payload." }, 400);
  }

  try {
    const user = await requireAuthenticatedUser();
    const snapshot = await persistSnapshotForUser(user.id, {
      analysis: body.analysis,
      deviceId: typeof body.deviceId === "string" ? body.deviceId : undefined,
      source: body.source ?? null,
      fileName: body.fileName,
      audioBase64: body.audioBase64,
      audioMimeType: body.audioMimeType,
      audioFileName: body.audioFileName
    });

    return jsonResponse({
      snapshot
    });
  } catch (error) {
    if (error instanceof Error && error.message === "UNAUTHORIZED") {
      return jsonResponse({ error: "Unauthorized" }, 401);
    }
    return jsonResponse(
      {
        error: error instanceof Error ? error.message : "Unable to persist snapshot."
      },
      500
    );
  }
}
