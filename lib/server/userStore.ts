import type { AnalysisHistoryEntry, SessionAnalysis } from "@/lib/analysisBundle";
import { ensureMongoIndexes, getCollections } from "@/lib/server/mongodb";
import type {
  PublicUser,
  SnapshotDocument,
  UserBackboardContext,
  UserDocument,
  UserPreferences
} from "@/lib/server/types";
import { Binary, ObjectId } from "mongodb";

const MAX_AUDIO_BYTES = 10 * 1024 * 1024;
const MAX_SNAPSHOT_LIMIT = 50;

type PersistSnapshotInput = {
  analysis: SessionAnalysis;
  deviceId?: string;
  source?: "record" | "upload" | null;
  fileName?: string;
  audioBase64?: string;
  audioMimeType?: string;
  audioFileName?: string;
};

type SnapshotSummary = {
  id: string;
  createdAt: string;
  deviceId?: string;
  source: "record" | "upload" | null;
  fileName?: string;
  hasAudio: boolean;
  analysis: SessionAnalysis;
  historyEntry: AnalysisHistoryEntry;
};

type SnapshotAudioResult = {
  mimeType: string;
  fileName?: string;
  bytes: Buffer;
};

function sanitizeEmail(email: string) {
  return email.trim().toLowerCase();
}

function sanitizeName(name: string | undefined, email: string) {
  const trimmed = (name ?? "").trim();
  if (trimmed) return trimmed.slice(0, 80);
  return email.split("@")[0]?.slice(0, 80) || "User";
}

function sanitizeDeviceId(deviceId: string | undefined) {
  const trimmed = (deviceId ?? "").trim();
  if (!trimmed) return undefined;
  return trimmed.slice(0, 160);
}

function ensureObjectId(id: string) {
  if (!ObjectId.isValid(id)) {
    throw new Error("Invalid identifier.");
  }

  return new ObjectId(id);
}

function toPublicUser(user: UserDocument): PublicUser {
  return {
    id: user._id.toString(),
    email: user.email,
    name: user.name,
    createdAt: user.createdAt.toISOString()
  };
}

function asDateFromIso(iso: string) {
  const parsed = new Date(iso);
  if (Number.isNaN(parsed.getTime())) {
    return new Date();
  }
  return parsed;
}

function clampLimit(rawLimit: number | undefined) {
  if (!rawLimit || !Number.isFinite(rawLimit)) return 20;
  return Math.max(1, Math.min(MAX_SNAPSHOT_LIMIT, Math.floor(rawLimit)));
}

function historyEntryFromAnalysis(analysis: SessionAnalysis): AnalysisHistoryEntry {
  return {
    createdAt: analysis.createdAt,
    score: analysis.score,
    envelope: analysis.waveform.envelope.slice(0, 600),
    duration: analysis.waveform.duration
  };
}

function parseAudioPayload(input: PersistSnapshotInput) {
  const encoded = input.audioBase64?.trim();
  if (!encoded) return null;

  const bytes = Buffer.from(encoded, "base64");
  if (!bytes.length) return null;
  if (bytes.length > MAX_AUDIO_BYTES) {
    throw new Error("Audio payload is too large. Max supported size is 10 MB.");
  }

  return {
    data: new Binary(bytes),
    mimeType: input.audioMimeType?.trim() || "audio/webm",
    fileName: input.audioFileName?.trim() || input.fileName?.trim() || undefined,
    size: bytes.length
  };
}

export async function createUser(input: {
  email: string;
  passwordHash: string;
  name?: string;
}) {
  await ensureMongoIndexes();
  const { users } = await getCollections();

  const emailLower = sanitizeEmail(input.email);
  const now = new Date();
  const doc: UserDocument = {
    _id: new ObjectId(),
    email: emailLower,
    emailLower,
    passwordHash: input.passwordHash,
    name: sanitizeName(input.name, emailLower),
    preferences: {},
    backboard: {},
    createdAt: now,
    updatedAt: now
  };

  await users.insertOne(doc);
  return {
    ...doc
  } satisfies UserDocument;
}

export async function findUserByEmail(email: string) {
  await ensureMongoIndexes();
  const { users } = await getCollections();
  const emailLower = sanitizeEmail(email);
  return users.findOne({ emailLower });
}

export async function findUserById(userId: string) {
  await ensureMongoIndexes();
  const { users } = await getCollections();
  const _id = ensureObjectId(userId);
  return users.findOne({ _id });
}

export async function listSnapshotsForUser(userId: string, limitRaw?: number): Promise<SnapshotSummary[]> {
  await ensureMongoIndexes();
  const { snapshots } = await getCollections();
  const _id = ensureObjectId(userId);
  const limit = clampLimit(limitRaw);

  const docs = await snapshots.find({ userId: _id }).sort({ createdAt: -1 }).limit(limit).toArray();

  return docs.map((doc) => ({
    id: doc._id.toString(),
    createdAt: doc.createdAtIso,
    deviceId: doc.deviceId,
    source: doc.source ?? null,
    fileName: doc.fileName,
    hasAudio: !!doc.hasAudio,
    analysis: doc.analysis,
    historyEntry: historyEntryFromAnalysis(doc.analysis)
  }));
}

export async function persistSnapshotForUser(userId: string, input: PersistSnapshotInput) {
  await ensureMongoIndexes();
  const { snapshots } = await getCollections();
  const _id = ensureObjectId(userId);

  const createdAtIso = typeof input.analysis?.createdAt === "string" ? input.analysis.createdAt : new Date().toISOString();
  const createdAt = asDateFromIso(createdAtIso);
  const now = new Date();
  const audio = parseAudioPayload(input);
  const deviceId = sanitizeDeviceId(input.deviceId);

  const baseUpdate: Partial<SnapshotDocument> = {
    analysis: input.analysis,
    deviceId,
    source: input.source ?? null,
    fileName: input.fileName?.trim() || undefined,
    hasAudio: !!audio,
    updatedAt: now
  };

  if (audio) {
    baseUpdate.audio = audio;
    if (!baseUpdate.fileName && audio.fileName) {
      baseUpdate.fileName = audio.fileName;
    }
  }

  const result = await snapshots.findOneAndUpdate(
    { userId: _id, createdAtIso },
    {
      $set: baseUpdate,
      $setOnInsert: {
        userId: _id,
        createdAt,
        createdAtIso
      }
    },
    {
      upsert: true,
      returnDocument: "after"
    }
  );

  if (!result) {
    throw new Error("Failed to persist snapshot.");
  }

  return {
    id: result._id.toString(),
    createdAt: result.createdAtIso
  };
}

export async function readSnapshotAudioForUser(userId: string, snapshotId: string): Promise<SnapshotAudioResult | null> {
  await ensureMongoIndexes();
  const { snapshots } = await getCollections();
  const _id = ensureObjectId(userId);
  const snapshotObjectId = ensureObjectId(snapshotId);

  const doc = await snapshots.findOne({ _id: snapshotObjectId, userId: _id });
  if (!doc?.audio?.data) return null;

  return {
    mimeType: doc.audio.mimeType || "audio/webm",
    fileName: doc.audio.fileName,
    bytes: Buffer.from(doc.audio.data.buffer)
  };
}

export async function readUserPreferences(userId: string): Promise<UserPreferences> {
  const user = await findUserById(userId);
  return user?.preferences ?? {};
}

export async function patchUserPreferences(userId: string, patch: UserPreferences): Promise<UserPreferences> {
  await ensureMongoIndexes();
  const { users } = await getCollections();
  const _id = ensureObjectId(userId);

  const sanitized: UserPreferences = {};
  if (typeof patch.demoMode === "boolean") sanitized.demoMode = patch.demoMode;
  if (typeof patch.voiceCoachEnabled === "boolean") sanitized.voiceCoachEnabled = patch.voiceCoachEnabled;
  if (typeof patch.reducedMotionOverride === "boolean" || patch.reducedMotionOverride === null) {
    sanitized.reducedMotionOverride = patch.reducedMotionOverride;
  }
  if (typeof patch.typicalCaptureTime === "string") {
    const trimmed = patch.typicalCaptureTime.trim();
    if (trimmed) sanitized.typicalCaptureTime = trimmed.slice(0, 16);
  }

  await users.updateOne(
    { _id },
    {
      $set: {
        updatedAt: new Date(),
        ...Object.fromEntries(
          Object.entries(sanitized).map(([key, value]) => [`preferences.${key}`, value])
        )
      }
    }
  );

  const updated = await users.findOne({ _id });
  return updated?.preferences ?? {};
}

export async function readUserBackboardContext(userId: string): Promise<UserBackboardContext> {
  const user = await findUserById(userId);
  return user?.backboard ?? {};
}

export async function patchUserBackboardContext(userId: string, patch: UserBackboardContext): Promise<UserBackboardContext> {
  await ensureMongoIndexes();
  const { users } = await getCollections();
  const _id = ensureObjectId(userId);

  const sanitized: UserBackboardContext = {};
  if (typeof patch.deviceId === "string" && patch.deviceId.trim()) sanitized.deviceId = patch.deviceId.trim().slice(0, 160);
  if (typeof patch.assistantId === "string" && patch.assistantId.trim()) {
    sanitized.assistantId = patch.assistantId.trim().slice(0, 160);
  }
  if (typeof patch.threadId === "string" && patch.threadId.trim()) sanitized.threadId = patch.threadId.trim().slice(0, 160);

  await users.updateOne(
    { _id },
    {
      $set: {
        updatedAt: new Date(),
        ...Object.fromEntries(
          Object.entries(sanitized).map(([key, value]) => [`backboard.${key}`, value])
        )
      }
    }
  );

  const updated = await users.findOne({ _id });
  return updated?.backboard ?? {};
}

export function toPublicUserFromDoc(user: UserDocument) {
  return toPublicUser(user);
}
