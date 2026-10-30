import { createFileRoute } from "@tanstack/react-router";

import { sessionFromRequest } from "@/server/auth.server";
import {
  consumeOAuthState,
  exchangeGoogleCode,
  googleConfigured,
  storeGoogleTokens,
} from "@/server/google.server";

function back(request: Request, path: string, message?: string): Response {
  const url = new URL(path, request.url);
  if (message) url.searchParams.set("google", message);
  return Response.redirect(url, 302);
}

export const Route = createFileRoute("/api/google/callback")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const url = new URL(request.url);
        const error = url.searchParams.get("error");
        if (error) {
          const detail = url.searchParams.get("error_description") ?? error;
          return back(request, "/app/settings", `error:${detail.slice(0, 200)}`);
        }
        const state = url.searchParams.get("state") ?? "";
        const code = url.searchParams.get("code") ?? "";
        const consumed = await consumeOAuthState(state, "google_sheets");
        if (!consumed) return back(request, "/app/settings", "error:expired state");
        if (!code) return back(request, "/app/settings", "error:missing code");
        if (!googleConfigured()) return back(request, "/app/settings", "error:not configured");

        const session = await sessionFromRequest(request);
        if (!session || session.tenantId !== consumed.tenantId) {
          return back(request, "/login");
        }
        try {
          const tokens = await exchangeGoogleCode(code);
          await storeGoogleTokens(session, tokens);
        } catch (caught) {
          const detail = caught instanceof Error ? caught.message : "token exchange failed";
          return back(request, "/app/settings", `error:${detail.slice(0, 200)}`);
        }
        const target = consumed.redirectTo?.startsWith("/") ? consumed.redirectTo : "/app/settings";
        return back(request, target, "connected");
      },
    },
  },
});
