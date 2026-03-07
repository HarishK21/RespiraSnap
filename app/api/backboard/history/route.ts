import { BackboardClient } from "backboard-sdk";

type HistoryRequestBody = {
  assistantId?: string;
  deviceId?: string;
};

type MemoryRecord = {
  id: string;
  createdAt: string;
  category: string;
  payload: Record<string, unknown>;
};

const BACKBOARD_BASE_URL = process.env.BACKBOARD_BASE_URL || "https://app.backboard.io/api";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function safeString(value: unknown, fallback = "") {
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

function parseJsonContent(content: unknown) {
  if (typeof content !== "string") return null;

  const trimmed = content.trim();
  if (!trimmed) return null;

  try {
    const parsed = JSON.parse(trimmed);
    return isObject(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function parseMemory(item: unknown) {
  if (!isObject(item)) return null;

  const metadata = isObject(item.metadata) ? item.metadata : {};
  const category = safeString(metadata.category);
  if (!category) return null;

  const contentPayload = parseJsonContent(item.content);
  const payload = contentPayload ?? metadata;
  const createdAt = safeString(item.createdAt, safeString(metadata.capturedAt, new Date().toISOString()));

  return {
    id: safeString(item.id, `${category}-${createdAt}`),
    createdAt,
    category,
    payload
  } satisfies MemoryRecord;
}

export async function POST(request: Request) {
  const apiKey = process.env.BACKBOARD_API_KEY;
  if (!apiKey) {
    return new Response(JSON.stringify({ error: "Missing BACKBOARD_API_KEY on the server." }), {
      status: 503,
      headers: {
        "content-type": "application/json"
      }
    });
  }

  let payload: HistoryRequestBody;
  try {
    payload = (await request.json()) as HistoryRequestBody;
  } catch {
    return new Response(JSON.stringify({ error: "Invalid JSON payload." }), {
      status: 400,
      headers: {
        "content-type": "application/json"
      }
    });
  }

  const assistantId = safeString(payload.assistantId);
  const deviceId = safeString(payload.deviceId);

  if (!assistantId) {
    return new Response(
      JSON.stringify({
        items: [],
        sampleCount: 0
      }),
      {
        status: 200,
        headers: {
          "content-type": "application/json"
        }
      }
    );
  }

  try {
    const client = new BackboardClient({
      apiKey,
      baseUrl: BACKBOARD_BASE_URL,
      timeout: 45000
    });

    const memories = await client.getMemories(assistantId);
    const allItems = (memories.memories ?? [])
      .map((item: unknown) => parseMemory(item))
      .filter((item: MemoryRecord | null): item is MemoryRecord => !!item);

    const filtered = allItems
      .filter((item: MemoryRecord) => {
        if (!deviceId) return true;
        const itemDeviceId = safeString(item.payload.deviceId);
        return !itemDeviceId || itemDeviceId === deviceId;
      })
      .sort(
        (left: MemoryRecord, right: MemoryRecord) =>
          new Date(right.createdAt).getTime() - new Date(left.createdAt).getTime()
      );

    const snapshotSummaries = filtered.filter((item: MemoryRecord) => item.category === "snapshot-summary");
    const samples = filtered.filter((item: MemoryRecord) => item.category === "breathing-sample");
    const preferredSettings = filtered.filter((item: MemoryRecord) => item.category === "preferred-settings");

    return new Response(
      JSON.stringify({
        items: snapshotSummaries,
        samples,
        preferredSettings,
        sampleCount: samples.length
      }),
      {
        status: 200,
        headers: {
          "content-type": "application/json"
        }
      }
    );
  } catch (error) {
    return new Response(
      JSON.stringify({
        error: error instanceof Error ? error.message : "Unable to fetch Backboard history."
      }),
      {
        status: 502,
        headers: {
          "content-type": "application/json"
        }
      }
    );
  }
}
