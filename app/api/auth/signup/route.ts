import bcrypt from "bcryptjs";
import { createUserSession, setSessionCookie } from "@/lib/server/auth";
import { createUser, findUserByEmail, toPublicUserFromDoc } from "@/lib/server/userStore";

type SignupBody = {
  email?: string;
  password?: string;
  name?: string;
};

function isValidEmail(value: string) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

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
  let body: SignupBody;
  try {
    body = (await request.json()) as SignupBody;
  } catch {
    return jsonResponse({ error: "Invalid JSON payload." }, 400);
  }

  const email = (body.email ?? "").trim().toLowerCase();
  const password = body.password ?? "";
  const name = (body.name ?? "").trim();

  if (!isValidEmail(email)) {
    return jsonResponse({ error: "Enter a valid email address." }, 400);
  }
  if (password.length < 8) {
    return jsonResponse({ error: "Password must be at least 8 characters." }, 400);
  }

  try {
    const existing = await findUserByEmail(email);
    if (existing) {
      return jsonResponse({ error: "An account with this email already exists." }, 409);
    }

    const passwordHash = await bcrypt.hash(password, 12);
    const user = await createUser({
      email,
      passwordHash,
      name
    });

    const token = await createUserSession(user._id.toString());
    setSessionCookie(token);

    return jsonResponse({
      user: toPublicUserFromDoc(user)
    });
  } catch (error) {
    return jsonResponse(
      {
        error: error instanceof Error ? error.message : "Unable to create account."
      },
      500
    );
  }
}
