import { createHash, randomBytes } from "crypto";
import { cookies } from "next/headers";
import { ObjectId } from "mongodb";
import { ensureMongoIndexes, getCollections } from "@/lib/server/mongodb";
import type { PublicUser } from "@/lib/server/types";
import { findUserById, toPublicUserFromDoc } from "@/lib/server/userStore";

export const SESSION_COOKIE_NAME = "respira_session";
const SESSION_TTL_MS = 1000 * 60 * 60 * 24 * 30;

function hashSessionToken(token: string) {
  return createHash("sha256").update(token).digest("hex");
}

function buildSessionToken() {
  return randomBytes(32).toString("hex");
}

function sessionExpiresAt() {
  return new Date(Date.now() + SESSION_TTL_MS);
}

export async function createUserSession(userId: string) {
  await ensureMongoIndexes();
  const { sessions } = await getCollections();

  const token = buildSessionToken();
  const tokenHash = hashSessionToken(token);
  const now = new Date();

  await sessions.insertOne({
    _id: new ObjectId(),
    userId: new ObjectId(userId),
    tokenHash,
    expiresAt: sessionExpiresAt(),
    createdAt: now,
    updatedAt: now
  });

  return token;
}

export function setSessionCookie(token: string) {
  cookies().set({
    name: SESSION_COOKIE_NAME,
    value: token,
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: Math.floor(SESSION_TTL_MS / 1000)
  });
}

export function clearSessionCookie() {
  cookies().set({
    name: SESSION_COOKIE_NAME,
    value: "",
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: 0
  });
}

export async function deleteUserSessionByToken(token: string | undefined) {
  if (!token) return;
  await ensureMongoIndexes();
  const { sessions } = await getCollections();
  await sessions.deleteOne({ tokenHash: hashSessionToken(token) });
}

export function readSessionTokenFromCookies() {
  return cookies().get(SESSION_COOKIE_NAME)?.value;
}

export async function readAuthenticatedUser(): Promise<PublicUser | null> {
  const token = readSessionTokenFromCookies();
  if (!token) return null;

  await ensureMongoIndexes();
  const { sessions } = await getCollections();
  const tokenHash = hashSessionToken(token);
  const now = new Date();

  const session = await sessions.findOne({ tokenHash });
  if (!session) return null;
  if (session.expiresAt.getTime() <= now.getTime()) {
    await sessions.deleteOne({ _id: session._id });
    return null;
  }

  const user = await findUserById(session.userId.toString());
  if (!user) return null;

  await sessions.updateOne(
    { _id: session._id },
    {
      $set: {
        updatedAt: now
      }
    }
  );

  return toPublicUserFromDoc(user);
}

export async function requireAuthenticatedUser() {
  const user = await readAuthenticatedUser();
  if (!user) {
    throw new Error("UNAUTHORIZED");
  }
  return user;
}
