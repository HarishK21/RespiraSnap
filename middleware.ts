import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

const SESSION_COOKIE_NAME = "respira_session";
const PROTECTED_PAGES = ["/record", "/results", "/history"];

function isProtectedPage(pathname: string) {
  return PROTECTED_PAGES.some((route) => pathname === route || pathname.startsWith(`${route}/`));
}

function isProtectedApi(pathname: string) {
  return pathname.startsWith("/api/user/");
}

export function middleware(request: NextRequest) {
  const { pathname, search } = request.nextUrl;
  const hasSession = !!request.cookies.get(SESSION_COOKIE_NAME)?.value;

  if ((isProtectedPage(pathname) || isProtectedApi(pathname)) && !hasSession) {
    if (isProtectedApi(pathname)) {
      return NextResponse.json(
        {
          error: "Unauthorized"
        },
        { status: 401 }
      );
    }

    const nextUrl = new URL("/login", request.url);
    nextUrl.searchParams.set("next", `${pathname}${search}`);
    return NextResponse.redirect(nextUrl);
  }

  return NextResponse.next();
}

export const config = {
  matcher: ["/record/:path*", "/results/:path*", "/history/:path*", "/api/user/:path*"]
};
