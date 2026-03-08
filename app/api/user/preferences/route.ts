import { requireAuthenticatedUser } from "@/lib/server/auth";
import { patchUserPreferences, readUserPreferences } from "@/lib/server/userStore";
import type { UserPreferences } from "@/lib/server/types";

function jsonResponse(payload: unknown, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      "content-type": "application/json"
    }
  });
}

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const user = await requireAuthenticatedUser();
    const preferences = await readUserPreferences(user.id);
    return jsonResponse({ preferences });
  } catch (error) {
    if (error instanceof Error && error.message === "UNAUTHORIZED") {
      return jsonResponse({ error: "Unauthorized" }, 401);
    }
    return jsonResponse({ error: "Unable to read preferences." }, 500);
  }
}

export async function POST(request: Request) {
  let payload: UserPreferences;
  try {
    payload = (await request.json()) as UserPreferences;
  } catch {
    return jsonResponse({ error: "Invalid JSON payload." }, 400);
  }

  try {
    const user = await requireAuthenticatedUser();
    const preferences = await patchUserPreferences(user.id, payload);
    return jsonResponse({ preferences });
  } catch (error) {
    if (error instanceof Error && error.message === "UNAUTHORIZED") {
      return jsonResponse({ error: "Unauthorized" }, 401);
    }
    return jsonResponse({ error: "Unable to update preferences." }, 500);
  }
}
