import bcrypt from "bcryptjs";
import { createUserSession, setSessionCookie } from "@/lib/server/auth";
import { findUserByEmail, toPublicUserFromDoc } from "@/lib/server/userStore";

type LoginBody = {
  email?: string;
  password?: string;
};

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

export async function POST(request: Request) {
  let body: LoginBody;
  try {
    body = (await request.json()) as LoginBody;
  } catch {
    return jsonResponse({ error: "Invalid JSON payload." }, 400);
  }

  const email = (body.email ?? "").trim().toLowerCase();
  const password = body.password ?? "";

  if (!email || !password) {
    return jsonResponse({ error: "Email and password are required." }, 400);
  }

  try {
    const user = await findUserByEmail(email);
    if (!user) {
      return jsonResponse({ error: "Invalid email or password." }, 401);
    }

    const valid = await bcrypt.compare(password, user.passwordHash);
    if (!valid) {
      return jsonResponse({ error: "Invalid email or password." }, 401);
    }

    const token = await createUserSession(user._id.toString());
    setSessionCookie(token);

    return jsonResponse({
      user: toPublicUserFromDoc(user)
    });
  } catch (error) {
    return jsonResponse(
      {
        error: error instanceof Error ? error.message : "Unable to sign in."
      },
      500
    );
  }
}
