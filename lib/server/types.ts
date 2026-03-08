import type { SessionAnalysis } from "@/lib/analysisBundle";
import type { Binary, ObjectId } from "mongodb";

export type UserPreferences = {
  reducedMotionOverride?: boolean | null;
  demoMode?: boolean;
  voiceCoachEnabled?: boolean;
  typicalCaptureTime?: string;
};

export type UserBackboardContext = {
  deviceId?: string;
  assistantId?: string;
  threadId?: string;
};

export type UserDocument = {
  _id: ObjectId;
  email: string;
  emailLower: string;
  passwordHash: string;
  name: string;
  preferences: UserPreferences;
  backboard: UserBackboardContext;
  createdAt: Date;
  updatedAt: Date;
};

export type SessionDocument = {
  _id: ObjectId;
  userId: ObjectId;
  tokenHash: string;
  expiresAt: Date;
  createdAt: Date;
  updatedAt: Date;
};

export type SnapshotAudioRecord = {
  data: Binary;
  mimeType: string;
  fileName?: string;
  size: number;
};

export type SnapshotDocument = {
  _id: ObjectId;
  userId: ObjectId;
  deviceId?: string;
  createdAt: Date;
  createdAtIso: string;
  analysis: SessionAnalysis;
  source: "record" | "upload" | null;
  fileName?: string;
  hasAudio: boolean;
  audio?: SnapshotAudioRecord;
  updatedAt: Date;
};

export type PublicUser = {
  id: string;
  email: string;
  name: string;
  createdAt: string;
};
