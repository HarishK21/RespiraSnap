import { requireAuthenticatedUser } from "@/lib/server/auth";
import { readSnapshotAudioForUser } from "@/lib/server/userStore";

type Context = {
  params: {
    snapshotId: string;
  };
};

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(_request: Request, context: Context) {
  try {
    const user = await requireAuthenticatedUser();
    const snapshotId = context.params.snapshotId;
    const audio = await readSnapshotAudioForUser(user.id, snapshotId);

    if (!audio) {
      return new Response(JSON.stringify({ error: "Audio not found." }), {
        status: 404,
        headers: {
          "content-type": "application/json"
        }
      });
    }

    const payload = new Uint8Array(audio.bytes.byteLength);
    payload.set(audio.bytes);

    return new Response(payload.buffer, {
      status: 200,
      headers: {
        "content-type": audio.mimeType || "audio/webm",
        "cache-control": "private, max-age=60",
        "content-disposition": `inline; filename="${audio.fileName || `${snapshotId}.webm`}"`,
        "content-length": String(audio.bytes.byteLength)
      }
    });
  } catch (error) {
    if (error instanceof Error && error.message === "UNAUTHORIZED") {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401,
        headers: {
          "content-type": "application/json"
        }
      });
    }

    return new Response(JSON.stringify({ error: "Unable to load snapshot audio." }), {
      status: 500,
      headers: {
        "content-type": "application/json"
      }
    });
  }
}
