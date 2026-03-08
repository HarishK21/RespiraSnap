import { BackboardClient } from "backboard-sdk";
import { ObjectId } from "mongodb";
import { readAuthenticatedUser } from "@/lib/server/auth";
import { ensureMongoIndexes, getCollections } from "@/lib/server/mongodb";

type ResetBody = {
  deviceId?: string;
  assistantId?: string;
  resetAll?: boolean;
};

type ResetStats = {
  snapshotsDeleted: number;
  memoriesDeleted: number;
  preferencesReset: boolean;
  backboardContextReset: boolean;
  scope: "user-device" | "user" | "demo-all" | "local-only";
};

const BACKBOARD_BASE_URL = process.env.BACKBOARD_BASE_URL || "https://app.backboard.io/api";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function safeString(value: unknown) {
  if (typeof value !== "string") return "";
  return value.trim();
}

function jsonResponse(payload: unknown, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      "content-type": "application/json"
    }
  });
}

function shouldDeleteMemory(memory: unknown, deviceId: string, resetAll: boolean) {
  if (!isObject(memory)) return false;
  if (resetAll) return true;
  if (!deviceId) return true;

  const metadata = isObject(memory.metadata) ? memory.metadata : {};
  const memoryDeviceId = safeString(metadata.deviceId);
  if (!memoryDeviceId) return true;
  return memoryDeviceId === deviceId;
}

async function deleteBackboardMemories(input: {
  assistantId: string;
  deviceId: string;
  resetAll: boolean;
}): Promise<number> {
  const apiKey = process.env.BACKBOARD_API_KEY?.trim();
  if (!apiKey || !input.assistantId) return 0;

  const client = new BackboardClient({
    apiKey,
    baseUrl: BACKBOARD_BASE_URL,
    timeout: 60000
  });

  const memories = await client.getMemories(input.assistantId);
  const list = Array.isArray(memories.memories) ? memories.memories : [];

  const memoryIds: string[] = list
    .filter((item: unknown) => shouldDeleteMemory(item, input.deviceId, input.resetAll))
    .map((item: unknown) => (isObject(item) ? safeString(item.id) : ""))
    .filter(Boolean);

  if (!memoryIds.length) return 0;

  const results = await Promise.allSettled(
    memoryIds.map((memoryId: string) => client.deleteMemory(input.assistantId, memoryId))
  );

  return results.filter((result) => result.status === "fulfilled").length;
}

async function deleteAllBackboardMemoriesForDemo(): Promise<number> {
  const apiKey = process.env.BACKBOARD_API_KEY?.trim();
  if (!apiKey) return 0;

  const client = new BackboardClient({
    apiKey,
    baseUrl: BACKBOARD_BASE_URL,
    timeout: 60000
  });

  const assistants = await client.listAssistants({ skip: 0, limit: 250 });
  let deletedCount = 0;

  for (const assistant of assistants) {
    const assistantId = safeString(assistant.assistantId);
    if (!assistantId) continue;

    const memories = await client.getMemories(assistantId);
    const memoryIds = (Array.isArray(memories.memories) ? memories.memories : [])
      .map((item: unknown) => (isObject(item) ? safeString(item.id) : ""))
      .filter(Boolean);

    if (!memoryIds.length) continue;

    const results = await Promise.allSettled(
      memoryIds.map((memoryId: string) => client.deleteMemory(assistantId, memoryId))
    );
    deletedCount += results.filter((result) => result.status === "fulfilled").length;
  }

  return deletedCount;
}

export async function POST(request: Request) {
  let payload: ResetBody = {};
  try {
    payload = (await request.json()) as ResetBody;
  } catch {
    // Allow empty body.
  }

  const deviceId = safeString(payload.deviceId);
  const assistantIdFromBody = safeString(payload.assistantId);
  const allowResetAll = process.env.NEXT_PUBLIC_DEMO_RESET_ALL === "true";
  const resetAll = allowResetAll && payload.resetAll === true;

  const user = await readAuthenticatedUser().catch(() => null);
  if (!user?.id || !ObjectId.isValid(user.id)) {
    return jsonResponse({ ok: false, error: "Unauthorized" }, 401);
  }

  const stats: ResetStats = {
    snapshotsDeleted: 0,
    memoriesDeleted: 0,
    preferencesReset: false,
    backboardContextReset: false,
    scope: "local-only"
  };

  try {
    await ensureMongoIndexes();
    const { snapshots, users } = await getCollections();

    if (resetAll) {
      const snapshotResult = await snapshots.deleteMany({});
      stats.snapshotsDeleted = snapshotResult.deletedCount ?? 0;
      stats.scope = "demo-all";

      const userResult = await users.updateMany(
        {},
        {
          $set: {
            updatedAt: new Date(),
            preferences: {},
            backboard: {}
          }
        }
      );

      stats.preferencesReset = userResult.modifiedCount > 0;
      stats.backboardContextReset = userResult.modifiedCount > 0;
    } else {
      const userObjectId = new ObjectId(user.id);
      const snapshotQuery: Record<string, unknown> = {
        userId: userObjectId
      };
      if (deviceId) {
        snapshotQuery.deviceId = deviceId;
        stats.scope = "user-device";
      } else {
        stats.scope = "user";
      }

      const snapshotResult = await snapshots.deleteMany(snapshotQuery);
      stats.snapshotsDeleted = snapshotResult.deletedCount ?? 0;

      const userDoc = await users.findOne({ _id: userObjectId });
      const sameDevice = safeString(userDoc?.backboard?.deviceId) === deviceId;
      const shouldClearUserWide = !deviceId || sameDevice;

      if (shouldClearUserWide) {
        const updateResult = await users.updateOne(
          { _id: userObjectId },
          {
            $set: {
              updatedAt: new Date(),
              preferences: {},
              backboard: {}
            }
          }
        );
        stats.preferencesReset = updateResult.modifiedCount > 0;
        stats.backboardContextReset = updateResult.modifiedCount > 0;
      }
    }

    if (resetAll) {
      stats.memoriesDeleted = await deleteAllBackboardMemoriesForDemo();
    } else {
      const assistantId =
        assistantIdFromBody || safeString((await users.findOne({ _id: new ObjectId(user.id) }))?.backboard?.assistantId);

      if (assistantId) {
        stats.memoriesDeleted = await deleteBackboardMemories({
          assistantId,
          deviceId,
          resetAll
        });
      }
    }

    return jsonResponse({ ok: true, stats });
  } catch (error) {
    return jsonResponse(
      {
        ok: false,
        error: error instanceof Error ? error.message : "Failed to reset data."
      },
      500
    );
  }
}
