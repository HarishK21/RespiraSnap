import { requireAuthenticatedUser } from "@/lib/server/auth";
import { patchUserBackboardContext, readUserBackboardContext } from "@/lib/server/userStore";
import type { UserBackboardContext } from "@/lib/server/types";

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
    const context = await readUserBackboardContext(user.id);
    return jsonResponse({ context });
  } catch (error) {
    if (error instanceof Error && error.message === "UNAUTHORIZED") {
      return jsonResponse({ error: "Unauthorized" }, 401);
    }
    return jsonResponse({ error: "Unable to read Backboard context." }, 500);
  }
}

export async function POST(request: Request) {
  let payload: UserBackboardContext;
  try {
    payload = (await request.json()) as UserBackboardContext;
  } catch {
    return jsonResponse({ error: "Invalid JSON payload." }, 400);
  }

  try {
    const user = await requireAuthenticatedUser();
    const context = await patchUserBackboardContext(user.id, payload);
    return jsonResponse({ context });
  } catch (error) {
    if (error instanceof Error && error.message === "UNAUTHORIZED") {
      return jsonResponse({ error: "Unauthorized" }, 401);
    }
    return jsonResponse({ error: "Unable to update Backboard context." }, 500);
  }
}
