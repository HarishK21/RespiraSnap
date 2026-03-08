import { clearSessionCookie, deleteUserSessionByToken, readSessionTokenFromCookies } from "@/lib/server/auth";

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

export async function POST() {
  const token = readSessionTokenFromCookies();
  await deleteUserSessionByToken(token);
  clearSessionCookie();
  return jsonResponse({ ok: true });
}
