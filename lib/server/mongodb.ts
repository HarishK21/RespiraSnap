import { MongoClient } from "mongodb";
import type { Db } from "mongodb";
import type { SessionDocument, SnapshotDocument, UserDocument } from "@/lib/server/types";

const FALLBACK_DB_NAME = "respirasnap";

declare global {
  // eslint-disable-next-line no-var
  var __respiraMongoClientPromise: Promise<MongoClient> | undefined;
  // eslint-disable-next-line no-var
  var __respiraMongoIndexesReady: boolean | undefined;
}

function getMongoUri() {
  const value = process.env.MONGODB_URI?.trim();
  if (!value) {
    throw new Error("Missing MONGODB_URI on the server.");
  }
  return value;
}

function getMongoDbName() {
  const fromEnv = process.env.MONGODB_DB?.trim();
  if (fromEnv) return fromEnv;
  return FALLBACK_DB_NAME;
}

function createClientPromise() {
  const uri = getMongoUri();
  const client = new MongoClient(uri);
  return client.connect();
}

export function getMongoClient() {
  if (!global.__respiraMongoClientPromise) {
    global.__respiraMongoClientPromise = createClientPromise();
  }

  return global.__respiraMongoClientPromise;
}

export async function getMongoDb(): Promise<Db> {
  const client = await getMongoClient();
  return client.db(getMongoDbName());
}

export async function getCollections() {
  const db = await getMongoDb();
  return {
    users: db.collection<UserDocument>("users"),
    sessions: db.collection<SessionDocument>("sessions"),
    snapshots: db.collection<SnapshotDocument>("snapshots")
  };
}

export async function ensureMongoIndexes() {
  if (global.__respiraMongoIndexesReady) return;

  const { users, sessions, snapshots } = await getCollections();

  await Promise.all([
    users.createIndex({ emailLower: 1 }, { unique: true }),
    sessions.createIndex({ tokenHash: 1 }, { unique: true }),
    sessions.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 }),
    snapshots.createIndex({ userId: 1, createdAtIso: 1 }, { unique: true }),
    snapshots.createIndex({ userId: 1, createdAt: -1 }),
    snapshots.createIndex({ userId: 1, deviceId: 1, createdAt: -1 })
  ]);

  global.__respiraMongoIndexesReady = true;
}
