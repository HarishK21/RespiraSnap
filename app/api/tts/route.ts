import { NextResponse } from "next/server";

const ELEVENLABS_BASE_URL = "https://api.elevenlabs.io/v1/text-to-speech";
const DEFAULT_VOICE_ID = process.env.ELEVENLABS_VOICE_ID ?? "EXAVITQu4vr4xnSDxMaL";
const DEFAULT_MODEL_ID = process.env.ELEVENLABS_MODEL_ID ?? "eleven_multilingual_v2";

type TtsRequestBody = {
  text?: string;
  voiceId?: string;
  modelId?: string;
};

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function toSafeMessage(value: unknown, fallback: string) {
  if (typeof value === "string" && value.trim()) return value;
  return fallback;
}

export async function POST(request: Request) {
  const apiKey = process.env.ELEVENLABS_API_KEY;
  if (!apiKey) {
    return NextResponse.json(
      {
        error: "Missing ELEVENLABS_API_KEY on the server."
      },
      { status: 503 }
    );
  }

  let payload: TtsRequestBody;
  try {
    payload = (await request.json()) as TtsRequestBody;
  } catch {
    return NextResponse.json({ error: "Invalid JSON request body." }, { status: 400 });
  }

  const text = payload.text?.trim();
  if (!text) {
    return NextResponse.json({ error: "`text` is required." }, { status: 400 });
  }

  if (text.length > 3200) {
    return NextResponse.json({ error: "`text` must be 3200 characters or fewer." }, { status: 400 });
  }

  const voiceId = payload.voiceId?.trim() || DEFAULT_VOICE_ID;
  const modelId = payload.modelId?.trim() || DEFAULT_MODEL_ID;

  try {
    const elevenResponse = await fetch(`${ELEVENLABS_BASE_URL}/${encodeURIComponent(voiceId)}`, {
      method: "POST",
      headers: {
        "xi-api-key": apiKey,
        "content-type": "application/json",
        accept: "audio/mpeg"
      },
      body: JSON.stringify({
        text,
        model_id: modelId,
        voice_settings: {
          stability: 0.45,
          similarity_boost: 0.78,
          style: 0.25,
          use_speaker_boost: true
        }
      }),
      cache: "no-store"
    });

    if (!elevenResponse.ok) {
      let detail = `ElevenLabs request failed (${elevenResponse.status}).`;

      try {
        const json = (await elevenResponse.json()) as { detail?: unknown };
        detail = toSafeMessage(json.detail, detail);
      } catch {
        // Keep fallback detail.
      }

      return NextResponse.json({ error: detail }, { status: elevenResponse.status });
    }

    const audioBuffer = await elevenResponse.arrayBuffer();
    return new NextResponse(audioBuffer, {
      status: 200,
      headers: {
        "content-type": "audio/mpeg",
        "cache-control": "no-store, max-age=0"
      }
    });
  } catch (error) {
    return NextResponse.json(
      {
        error: toSafeMessage((error as Error | undefined)?.message, "Unable to reach ElevenLabs.")
      },
      { status: 502 }
    );
  }
}
