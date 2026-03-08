import { readAuthenticatedUser } from "@/lib/server/auth";

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
  const user = await readAuthenticatedUser();
  return jsonResponse({ user });
}
