import { timingSafeEqual } from "node:crypto";
import { createFileRoute } from "@tanstack/react-router";

import { env } from "@/server/env.server";
import { runDueJobs, scheduleDailyJobs } from "@/server/jobs.server";

function json(data: Record<string, unknown>, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}

function providedSecret(request: Request): string {
  const header = request.headers.get("x-cron-secret") ?? "";
  if (header) return header;
  const authorization = request.headers.get("authorization") ?? "";
  return authorization.toLowerCase().startsWith("bearer ") ? authorization.slice(7) : "";
}

function authorised(request: Request): boolean {
  if (!env.cronSecret) return false;
  const provided = Buffer.from(providedSecret(request));
  const expected = Buffer.from(env.cronSecret);
  return provided.length === expected.length && timingSafeEqual(provided, expected);
}

async function tick(request: Request): Promise<Response> {
  if (!env.cronSecret) {
    return json({ error: "CRON_SECRET is not configured." }, 503);
  }
  if (!authorised(request)) return json({ error: "Unauthorized." }, 401);

  const url = new URL(request.url);
  const queued =
    url.searchParams.get("schedule") === "1" ? await scheduleDailyJobs() : { queued: 0 };
  const result = await runDueJobs(25);
  return json({ ok: true, queued: queued.queued, ...result });
}

export const Route = createFileRoute("/api/jobs/run")({
  server: {
    handlers: {
      GET: ({ request }) => tick(request),
      POST: ({ request }) => tick(request),
    },
  },
});
