import { BackboardClient } from "backboard-sdk";

type AgentKey = "segmentation" | "baselineTrend" | "clinicalSummary" | "coaching" | "followUp";

type AnalyzeRequestBody = {
  deviceId?: string;
  assistantId?: string;
  threadId?: string;
  mode?: string;
  session?: {
    source?: string;
    duration?: number;
    capturedAt?: string;
  };
  preferences?: {
    voiceCoachEnabled?: boolean;
    reducedMotion?: boolean;
    typicalCaptureTime?: string;
  };
  features?: {
    envelope?: number[];
    energy?: number[];
    stats?: {
      averageEnergy?: number;
      peakEnergy?: number;
      energyVariance?: number;
      rhythmStability?: number;
    };
    markers?: Array<{ time: number; label: string }>;
  };
  historyContext?: {
    sessions?: Array<{
      createdAt?: string;
      score?: number;
      confidence?: "low" | "med" | "high" | string;
      quality?: "Good" | "Fair" | "Poor" | "Noisy" | string;
      pillars?: {
        rhythmLabel?: string;
        exhaleRatio?: number | null;
        interruptions?: number;
        holdDetected?: boolean | null;
      };
    }>;
  };
};

type TrendLabel = "Improving" | "Stable" | "Worsening" | "Baseline building";

type PriorSessionContext = {
  createdAt: string;
  score: number;
  confidence: "low" | "med" | "high";
  quality: "Good" | "Fair" | "Poor" | "Noisy";
  pillars: {
    rhythmLabel: string;
    exhaleRatio: number | null;
    interruptions: number | null;
    holdDetected: boolean | null;
  };
};

type AgentStep = {
  key: AgentKey;
  title: string;
  modelLabel: "A" | "B" | "C" | "D";
};

type AgentEvent = {
  type: "agent";
  key: AgentKey;
  title: string;
  modelLabel: string;
  status: "queued" | "running" | "done" | "error";
  output?: unknown;
  message?: string;
};

const AGENT_STEPS: AgentStep[] = [
  { key: "segmentation", title: "Segmentation Agent", modelLabel: "A" },
  { key: "baselineTrend", title: "Baseline & Trend Agent", modelLabel: "B" },
  { key: "clinicalSummary", title: "Clinical Summary Agent", modelLabel: "C" },
  { key: "coaching", title: "Coaching Agent", modelLabel: "D" },
  { key: "followUp", title: "Follow-up Agent", modelLabel: "D" }
];

const BACKBOARD_BASE_URL = process.env.BACKBOARD_BASE_URL || "https://app.backboard.io/api";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function safeNumber(value: unknown, fallback = 0) {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function toSerializableArray(values: unknown, maxLength: number) {
  if (!Array.isArray(values)) return [];

  return values
    .slice(0, maxLength)
    .map((value) => {
      if (typeof value !== "number" || !Number.isFinite(value)) return 0;
      return Number(clamp(value, 0, 1).toFixed(4));
    });
}

function confidenceFromSamples(sampleCount: number): "low" | "med" | "high" {
  if (sampleCount >= 8) return "high";
  if (sampleCount >= 3) return "med";
  return "low";
}

function parseConfidence(value: unknown, fallback: "low" | "med" | "high") {
  const normalized = safeString(value).toLowerCase();
  if (normalized === "low" || normalized === "med" || normalized === "high") return normalized;
  return fallback;
}

function median(values: number[]) {
  if (!values.length) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 0) return (sorted[middle - 1] + sorted[middle]) / 2;
  return sorted[middle];
}

function trendLabelFromDelta(totalSessions: number, delta: number): TrendLabel {
  if (totalSessions < 3) return "Baseline building";
  if (delta >= 4) return "Improving";
  if (delta <= -4) return "Worsening";
  return "Stable";
}

function normalizeTrendLabel(value: unknown, fallback: TrendLabel): TrendLabel {
  const normalized = safeString(value).toLowerCase();
  if (normalized === "improving") return "Improving";
  if (normalized === "stable") return "Stable";
  if (normalized === "worsening") return "Worsening";
  if (normalized === "baseline building") return "Baseline building";
  return fallback;
}

function parseDeltaValue(value: unknown, fallback: number) {
  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.round(value);
  }

  const text = safeString(value);
  if (!text) return fallback;
  const match = text.match(/[-+]?\d+/);
  if (!match) return fallback;
  const parsed = Number(match[0]);
  return Number.isFinite(parsed) ? Math.round(parsed) : fallback;
}

function sanitizeHistoryContext(sessions: unknown): PriorSessionContext[] {
  if (!Array.isArray(sessions)) return [];

  const parsed = sessions
    .map((entry) => {
      if (!isObject(entry)) return null;

      const createdAt = safeString(entry.createdAt, new Date().toISOString());
      const score = clamp(Math.round(safeNumber(entry.score, NaN)), 0, 100);
      if (!Number.isFinite(score)) return null;

      const confidence = parseConfidence(entry.confidence, "low");
      const qualityRaw = safeString(entry.quality, "Good");
      const quality: PriorSessionContext["quality"] =
        qualityRaw === "Fair" || qualityRaw === "Poor" || qualityRaw === "Noisy" ? qualityRaw : "Good";
      const pillars = isObject(entry.pillars) ? entry.pillars : {};

      return {
        createdAt,
        score,
        confidence,
        quality,
        pillars: {
          rhythmLabel: safeString(pillars.rhythmLabel, "Unknown"),
          exhaleRatio:
            typeof pillars.exhaleRatio === "number" && Number.isFinite(pillars.exhaleRatio)
              ? Number(pillars.exhaleRatio.toFixed(3))
              : null,
          interruptions:
            typeof pillars.interruptions === "number" && Number.isFinite(pillars.interruptions)
              ? Math.max(0, Math.floor(pillars.interruptions))
              : null,
          holdDetected:
            typeof pillars.holdDetected === "boolean" || pillars.holdDetected === null ? pillars.holdDetected : null
        }
      } satisfies PriorSessionContext;
    })
    .filter((entry): entry is PriorSessionContext => !!entry)
    .sort((left, right) => new Date(right.createdAt).getTime() - new Date(left.createdAt).getTime());

  return parsed.slice(0, 4);
}

function summarizeCurrentPillars(segmentation: unknown) {
  if (!isObject(segmentation)) {
    return {
      rhythmLabel: "Unknown",
      exhaleRatio: null as number | null,
      interruptions: null as number | null,
      holdDetected: null as boolean | null
    };
  }

  let inhaleDuration = 0;
  let exhaleDuration = 0;
  let holdDuration = 0;

  const segments = Array.isArray(segmentation.segments) ? segmentation.segments : [];
  segments.forEach((segment) => {
    if (!isObject(segment)) return;
    const start = safeNumber(segment.start, NaN);
    const end = safeNumber(segment.end, NaN);
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return;
    const duration = end - start;
    const label = safeString(segment.label).toLowerCase();
    if (label.includes("inhale")) inhaleDuration += duration;
    if (label.includes("exhale")) exhaleDuration += duration;
    if (label.includes("hold")) holdDuration += duration;
  });

  const irregularCount = Array.isArray(segmentation.irregularWindows) ? segmentation.irregularWindows.length : 0;
  const rhythmLabel = irregularCount <= 1 ? "Stable" : irregularCount <= 3 ? "Slightly Variable" : "Variable";

  return {
    rhythmLabel,
    exhaleRatio: inhaleDuration > 0 ? Number((exhaleDuration / inhaleDuration).toFixed(3)) : null,
    interruptions: Number.isFinite(irregularCount) ? irregularCount : null,
    holdDetected: holdDuration > 0.3 ? true : holdDuration >= 0 ? false : null
  };
}

function computeSnapshotScore(
  stats: {
    averageEnergy?: number;
    rhythmStability?: number;
  },
  segmentation: unknown
) {
  const averageEnergy = clamp(safeNumber(stats.averageEnergy, 0), 0, 1);
  const rhythmStability = clamp(safeNumber(stats.rhythmStability, 0), 0, 1);
  const irregularCount = isObject(segmentation) && Array.isArray(segmentation.irregularWindows)
    ? segmentation.irregularWindows.length
    : 0;

  return clamp(Math.round(60 + rhythmStability * 24 + averageEnergy * 14 - irregularCount * 6), 0, 100);
}

function parseJsonFromText(content: string) {
  const trimmed = content.trim();
  if (!trimmed) return null;

  try {
    return JSON.parse(trimmed) as Record<string, unknown>;
  } catch {
    // Keep parsing.
  }

  const fenced = trimmed.match(/```json\s*([\s\S]*?)```/i) ?? trimmed.match(/```\s*([\s\S]*?)```/i);
  if (fenced?.[1]) {
    try {
      return JSON.parse(fenced[1].trim()) as Record<string, unknown>;
    } catch {
      // Keep parsing.
    }
  }

  const firstBrace = trimmed.indexOf("{");
  const lastBrace = trimmed.lastIndexOf("}");
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    const candidate = trimmed.slice(firstBrace, lastBrace + 1);
    try {
      return JSON.parse(candidate) as Record<string, unknown>;
    } catch {
      return null;
    }
  }

  return null;
}

function safeString(value: unknown, fallback = "") {
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

function emitSse(controller: ReadableStreamDefaultController<Uint8Array>, payload: unknown) {
  const encoded = new TextEncoder().encode(`data: ${JSON.stringify(payload)}\n\n`);
  controller.enqueue(encoded);
}

function buildSegmentationPrompt(input: {
  deviceId: string;
  mode: string;
  source: string;
  features: AnalyzeRequestBody["features"];
  session: NonNullable<AnalyzeRequestBody["session"]>;
}) {
  return `
You are the RespiraSnap Segmentation Agent.

Task:
1. Use the breathing audio features to estimate inhale/hold/exhale segments.
2. Detect irregular rhythm windows.
3. Keep results concise and approximate.

Return STRICT JSON only in this shape:
{
  "segments": [{"start": 0.0, "end": 0.0, "label": "inhale|hold|exhale", "confidence": 0.0}],
  "irregularWindows": [{"start": 0.0, "end": 0.0, "reason": "string"}],
  "segmentCount": 0,
  "notes": "string"
}

Context:
- deviceId: ${input.deviceId}
- mode: ${input.mode}
- source: ${input.source}
- durationSeconds: ${safeNumber(input.session.duration, 0).toFixed(2)}
- featureStats: ${JSON.stringify(input.features?.stats ?? {})}
- envelope: ${JSON.stringify(input.features?.envelope ?? [])}
- energy: ${JSON.stringify(input.features?.energy ?? [])}
- markerHints: ${JSON.stringify(input.features?.markers ?? [])}
`.trim();
}

function buildBaselinePrompt(input: {
  deviceId: string;
  mode: string;
  currentStats: NonNullable<AnalyzeRequestBody["features"]>["stats"];
  segmentation: unknown;
  sampleCount: number;
  recentSessions: PriorSessionContext[];
  currentPillars: {
    rhythmLabel: string;
    exhaleRatio: number | null;
    interruptions: number | null;
    holdDetected: boolean | null;
  };
}) {
  return `
You are the Baseline & Trend Agent for RespiraSnap.
Use conversation memory for this assistant to compare current breathing pattern with historical snapshots for this device.

Return STRICT JSON only:
{
  "trendLabel": "Improving|Stable|Worsening|Baseline building",
  "deltaValue": 0,
  "baselineDelta": "string",
  "confidence": "low|med|high",
  "samplesUsed": 0,
  "trendReason": "string",
  "pillarDeltaSummary": "string"
}

Rules:
- Confidence must consider number of samples.
- Mention if history is limited.
- Keep trendReason <= 12 words.
- Use only rhythm/exhale ratio/interruptions/hold wording.
- Keep it non-diagnostic.

Context:
- deviceId: ${input.deviceId}
- mode: ${input.mode}
- currentStats: ${JSON.stringify(input.currentStats ?? {})}
- segmentation: ${JSON.stringify(input.segmentation ?? {})}
- currentPillars: ${JSON.stringify(input.currentPillars)}
- recentSessions(last ${input.recentSessions.length}): ${JSON.stringify(input.recentSessions)}
- observedSampleCountIncludingCurrent: ${input.sampleCount}
`.trim();
}

function buildClinicalPrompt(input: {
  mode: string;
  segmentation: unknown;
  baseline: unknown;
}) {
  return `
You are the Clinical Summary Agent for RespiraSnap.
Create a concise clinician-style summary that is explicitly non-diagnostic.

Return STRICT JSON only:
{
  "summary": "string",
  "nonDiagnosticNote": "string"
}

Context:
- mode: ${input.mode}
- segmentation: ${JSON.stringify(input.segmentation ?? {})}
- baselineTrend: ${JSON.stringify(input.baseline ?? {})}
`.trim();
}

function buildCoachingPrompt(input: {
  segmentation: unknown;
  baseline: unknown;
  preferences: AnalyzeRequestBody["preferences"];
}) {
  return `
You are the Coaching Agent.
Generate one micro-intervention for breathing technique improvement and one tip for the next recording.

Return STRICT JSON only:
{
  "microIntervention": "string",
  "nextRecordingTip": "string"
}

Context:
- segmentation: ${JSON.stringify(input.segmentation ?? {})}
- baselineTrend: ${JSON.stringify(input.baseline ?? {})}
- preferences: ${JSON.stringify(input.preferences ?? {})}
`.trim();
}

function buildFollowUpPrompt(input: {
  deviceId: string;
  preferences: AnalyzeRequestBody["preferences"];
  baseline: unknown;
  coaching: unknown;
}) {
  return `
You are the Follow-up Agent.
Create a next-week check-in prompt and preserve preferred settings.

Return STRICT JSON only:
{
  "nextWeekPrompt": "string",
  "preferredSettings": {
    "voiceCoachEnabled": true,
    "typicalCaptureTime": "HH:MM",
    "reducedMotion": false
  },
  "continuityNote": "string"
}

Remember the settings for future sessions for this device.

Context:
- deviceId: ${input.deviceId}
- preferences: ${JSON.stringify(input.preferences ?? {})}
- baselineTrend: ${JSON.stringify(input.baseline ?? {})}
- coaching: ${JSON.stringify(input.coaching ?? {})}
`.trim();
}

async function ensureAssistant(client: BackboardClient, assistantId: string | undefined, deviceId: string) {
  if (assistantId) return assistantId;

  const assistant = await client.createAssistant({
    name: `RespiraSnap-${deviceId.slice(0, 8)}`,
    system_prompt:
      "You are RespiraSnap's multi-agent backend. Return strict JSON when asked and keep all outputs concise, calm, and non-diagnostic."
  });

  return assistant.assistantId;
}

async function ensureThread(client: BackboardClient, assistantId: string, threadId: string | undefined) {
  if (threadId) return threadId;

  const thread = await client.createThread(assistantId);
  return thread.threadId;
}

async function runBackboardStep(client: BackboardClient, threadId: string, prompt: string) {
  const response = await client.addMessage(threadId, {
    content: prompt,
    stream: false,
    memory: "Auto"
  });

  if (!isObject(response) || !("content" in response)) {
    throw new Error("Backboard returned a streaming response unexpectedly.");
  }

  const content = safeString(response.content, "{}");
  const parsed = parseJsonFromText(content);

  return {
    parsed,
    raw: content,
    provider: safeString(("modelProvider" in response ? response.modelProvider : "") as unknown, "Backboard"),
    modelName: safeString(("modelName" in response ? response.modelName : "") as unknown, "default")
  };
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

  let payload: AnalyzeRequestBody;
  try {
    payload = (await request.json()) as AnalyzeRequestBody;
  } catch {
    return new Response(JSON.stringify({ error: "Invalid JSON payload." }), {
      status: 400,
      headers: {
        "content-type": "application/json"
      }
    });
  }

  const deviceId = safeString(payload.deviceId);
  if (!deviceId) {
    return new Response(JSON.stringify({ error: "deviceId is required." }), {
      status: 400,
      headers: {
        "content-type": "application/json"
      }
    });
  }

  const session = {
    source: safeString(payload.session?.source, "unknown"),
    duration: safeNumber(payload.session?.duration, 0),
    capturedAt: safeString(payload.session?.capturedAt, new Date().toISOString())
  };

  const features = {
    envelope: toSerializableArray(payload.features?.envelope, 140),
    energy: toSerializableArray(payload.features?.energy, 140),
    stats: {
      averageEnergy: Number(safeNumber(payload.features?.stats?.averageEnergy, 0).toFixed(4)),
      peakEnergy: Number(safeNumber(payload.features?.stats?.peakEnergy, 0).toFixed(4)),
      energyVariance: Number(safeNumber(payload.features?.stats?.energyVariance, 0).toFixed(4)),
      rhythmStability: Number(safeNumber(payload.features?.stats?.rhythmStability, 0).toFixed(4))
    },
    markers: (payload.features?.markers ?? []).slice(0, 12).map((marker) => ({
      time: Number(clamp(safeNumber(marker.time, 0), 0, Math.max(0, session.duration || 60)).toFixed(3)),
      label: safeString(marker.label, "event")
    }))
  };

  const preferences = {
    voiceCoachEnabled: Boolean(payload.preferences?.voiceCoachEnabled),
    reducedMotion: Boolean(payload.preferences?.reducedMotion),
    typicalCaptureTime: safeString(payload.preferences?.typicalCaptureTime, "unknown")
  };

  const mode = safeString(payload.mode, "breathing");
  const recentSessions = sanitizeHistoryContext(payload.historyContext?.sessions);

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      void (async () => {
        const client = new BackboardClient({
          apiKey,
          baseUrl: BACKBOARD_BASE_URL,
          timeout: 60000
        });

        const results: Record<string, unknown> = {};

        try {
          const assistantId = await ensureAssistant(client, safeString(payload.assistantId), deviceId);
          const threadId = await ensureThread(client, assistantId, safeString(payload.threadId));

          emitSse(controller, {
            type: "init",
            assistantId,
            threadId,
            deviceId,
            steps: AGENT_STEPS
          });

          AGENT_STEPS.forEach((step) => {
            emitSse(controller, {
              type: "agent",
              key: step.key,
              title: step.title,
              modelLabel: step.modelLabel,
              status: "queued"
            } satisfies AgentEvent);
          });

          // Store this sample so baseline/trend can compare against historical state.
          await client.addMemory(assistantId, {
            content: JSON.stringify({
              category: "breathing-sample",
              deviceId,
              mode,
              capturedAt: session.capturedAt,
              source: session.source,
              duration: session.duration,
              featureStats: features.stats
            }),
            metadata: {
              category: "breathing-sample",
              deviceId,
              capturedAt: session.capturedAt,
              mode
            }
          });

          let samplesForDevice = 1;
          try {
            const memories = await client.getMemories(assistantId);
            samplesForDevice =
              memories.memories?.filter((memory: unknown) => {
                if (!isObject(memory)) return false;
                const metadata = isObject(memory.metadata) ? memory.metadata : {};
                return metadata.category === "breathing-sample" && metadata.deviceId === deviceId;
              }).length || 1;
          } catch {
            samplesForDevice = 1;
          }

          const runStep = async (
            step: AgentStep,
            promptBuilder: () => string,
            postProcess?: (parsed: Record<string, unknown> | null) => Record<string, unknown>
          ) => {
            emitSse(controller, {
              type: "agent",
              key: step.key,
              title: step.title,
              modelLabel: step.modelLabel,
              status: "running"
            } satisfies AgentEvent);

            try {
              const response = await runBackboardStep(client, threadId, promptBuilder());
              const parsed = postProcess
                ? postProcess(response.parsed)
                : response.parsed ?? { raw: response.raw };

              results[step.key] = parsed;

              emitSse(controller, {
                type: "agent",
                key: step.key,
                title: step.title,
                modelLabel: step.modelLabel,
                status: "done",
                output: {
                  model: `${response.provider}/${response.modelName}`,
                  result: parsed
                }
              } satisfies AgentEvent);
            } catch (error) {
              const message =
                error instanceof Error ? error.message : `Unknown failure while running ${step.title}.`;

              results[step.key] = { error: message };

              emitSse(controller, {
                type: "agent",
                key: step.key,
                title: step.title,
                modelLabel: step.modelLabel,
                status: "error",
                message
              } satisfies AgentEvent);
            }
          };

          await runStep(AGENT_STEPS[0], () =>
            buildSegmentationPrompt({
              deviceId,
              mode,
              source: session.source,
              features,
              session
            })
          );

          await runStep(
            AGENT_STEPS[1],
            () =>
              buildBaselinePrompt({
                deviceId,
                mode,
                currentStats: features.stats,
                segmentation: results.segmentation,
                sampleCount: samplesForDevice,
                recentSessions,
                currentPillars: summarizeCurrentPillars(results.segmentation)
              }),
            (parsed) => {
              const currentScore = computeSnapshotScore(features.stats, results.segmentation);
              const comparedScores = recentSessions.map((session) => session.score).slice(0, 4);
              const comparedCount = comparedScores.length;
              const baselineMedian = comparedCount ? median(comparedScores) : currentScore;
              const fallbackDeltaValue = Math.round(currentScore - baselineMedian);
              const parsedDeltaValue = parseDeltaValue(parsed?.deltaValue ?? parsed?.baselineDelta, fallbackDeltaValue);
              const totalSamples = Math.max(samplesForDevice, comparedCount + 1);
              const fallbackTrend = trendLabelFromDelta(totalSamples, parsedDeltaValue);
              const trendLabel = normalizeTrendLabel(parsed?.trendLabel, fallbackTrend);
              const baselineDelta = safeString(
                parsed?.baselineDelta,
                `${parsedDeltaValue >= 0 ? "+" : ""}${parsedDeltaValue} vs baseline`
              );
              const trendReason = safeString(
                parsed?.trendReason,
                safeString(parsed?.trendNote, "Collect more sessions for stronger trend confidence.")
              );
              const confidence = parseConfidence(parsed?.confidence, confidenceFromSamples(totalSamples));
              const pillarDeltaSummary = safeString(parsed?.pillarDeltaSummary);

              return {
                trendLabel,
                deltaValue: parsedDeltaValue,
                baselineDelta,
                confidence,
                samplesUsed: totalSamples,
                trendReason,
                trendNote: trendReason,
                pillarDeltaSummary
              };
            }
          );

          await runStep(AGENT_STEPS[2], () =>
            buildClinicalPrompt({
              mode,
              segmentation: results.segmentation,
              baseline: results.baselineTrend
            })
          );

          await runStep(AGENT_STEPS[3], () =>
            buildCoachingPrompt({
              segmentation: results.segmentation,
              baseline: results.baselineTrend,
              preferences
            })
          );

          await runStep(AGENT_STEPS[4], () =>
            buildFollowUpPrompt({
              deviceId,
              preferences,
              baseline: results.baselineTrend,
              coaching: results.coaching
            })
          );

          // Persist preferred settings explicitly for continuity on future sessions.
          await client.addMemory(assistantId, {
            content: JSON.stringify({
              category: "preferred-settings",
              deviceId,
              voiceCoachEnabled: preferences.voiceCoachEnabled,
              reducedMotion: preferences.reducedMotion,
              typicalCaptureTime: preferences.typicalCaptureTime,
              updatedAt: new Date().toISOString()
            }),
            metadata: {
              category: "preferred-settings",
              deviceId
            }
          });

          const baselineResult = isObject(results.baselineTrend) ? results.baselineTrend : {};
          const clinicalResult = isObject(results.clinicalSummary) ? results.clinicalSummary : {};
          const coachingResult = isObject(results.coaching) ? results.coaching : {};
          const followUpResult = isObject(results.followUp) ? results.followUp : {};
          const segmentationResult = isObject(results.segmentation) ? results.segmentation : {};
          const snapshotScore = computeSnapshotScore(features.stats, segmentationResult);
          const currentPillars = summarizeCurrentPillars(segmentationResult);

          await client.addMemory(assistantId, {
            content: JSON.stringify({
              category: "snapshot-summary",
              deviceId,
              mode,
              source: session.source,
              capturedAt: session.capturedAt,
              duration: session.duration,
              score: snapshotScore,
              baselineDelta: safeString(baselineResult.baselineDelta, "Baseline pending"),
              trendLabel: safeString(baselineResult.trendLabel, "Baseline building"),
              deltaValue: safeNumber(baselineResult.deltaValue, 0),
              confidence: safeString(baselineResult.confidence, confidenceFromSamples(samplesForDevice)),
              trendReason: safeString(baselineResult.trendReason, safeString(baselineResult.trendNote)),
              pillarDeltaSummary: safeString(baselineResult.pillarDeltaSummary),
              clinicianSummary: safeString(clinicalResult.summary),
              coachingTip: safeString(coachingResult.microIntervention),
              followUpPrompt: safeString(followUpResult.nextWeekPrompt),
              pillars: currentPillars,
              featureStats: features.stats,
              envelope: features.envelope.slice(0, 64)
            }),
            metadata: {
              category: "snapshot-summary",
              deviceId,
              capturedAt: session.capturedAt,
              mode
            }
          });

          emitSse(controller, {
            type: "complete",
            assistantId,
            threadId,
            deviceId,
            results
          });
        } catch (error) {
          emitSse(controller, {
            type: "fatal",
            message: error instanceof Error ? error.message : "Backboard pipeline failed unexpectedly."
          });
        } finally {
          controller.close();
        }
      })();
    }
  });

  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive"
    }
  });
}
