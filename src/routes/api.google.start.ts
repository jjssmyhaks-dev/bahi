import { createFileRoute } from "@tanstack/react-router";

import { sessionFromRequest } from "@/server/auth.server";
import {
  createOAuthState,
  googleConfigured,
  googleConsentUrl,
  googleRedirectUri,
} from "@/server/google.server";

export const Route = createFileRoute("/api/google/start")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const session = await sessionFromRequest(request);
        if (!session) return Response.redirect(new URL("/login", request.url), 302);
        if (!googleConfigured() || !googleRedirectUri()) {
          return new Response(
            "Google OAuth is not configured. Set GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, APP_BASE_URL (or GOOGLE_REDIRECT_URI) and TOKEN_ENCRYPTION_KEY.",
            { status: 503, headers: { "content-type": "text/plain; charset=utf-8" } },
          );
        }
        if (session.role === "viewer") {
          return new Response("Viewers cannot connect Google Sheets.", { status: 403 });
        }
        const state = await createOAuthState(
          session.tenantId,
          session.userId,
          "google_sheets",
          "/app/settings",
        );
        return Response.redirect(googleConsentUrl(state), 302);
      },
    },
  },
});
