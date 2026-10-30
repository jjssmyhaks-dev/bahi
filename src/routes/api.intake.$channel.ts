import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";

import {
  alreadyProcessed,
  authenticateIntake,
  recordIntakeEvent,
  type IntakeChannel,
  type IntakeFile,
} from "@/server/intake.server";
import { enqueueJob, runJobById } from "@/server/jobs.server";

const FILE = z.object({
  name: z.string().trim().min(1).max(200),
  mimeType: z.string().trim().min(1).max(150),
  base64: z.string().min(16).max(20_000_000),
});

const BODY = z.object({
  address: z.string().trim().min(3).max(200),
  secret: z.string().min(10).max(200),
  files: z.array(FILE).min(1).max(5).optional(),
  text: z.string().min(1).max(200_000).optional(),
  note: z.string().max(1000).optional(),
  externalId: z.string().trim().max(200).optional(),
  from: z.string().trim().max(200).optional(),
});

function json(data: Record<string, unknown>, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}

export const Route = createFileRoute("/api/intake/$channel")({
  server: {
    handlers: {
      POST: async ({ request, params }) => {
        const channel = params.channel;
        if (channel !== "email" && channel !== "whatsapp") {
          return json({ error: "Unknown intake channel." }, 404);
        }

        let payload: unknown;
        try {
          payload = await request.json();
        } catch {
          return json({ error: "Send a JSON body." }, 400);
        }
        const parsed = BODY.safeParse(payload);
        if (!parsed.success) {
          return json(
            { error: "The intake payload is not valid.", issues: parsed.error.issues },
            400,
          );
        }
        const body = parsed.data;

        const source = await authenticateIntake(
          channel as IntakeChannel,
          body.address,
          body.secret,
        );
        if (!source) return json({ error: "Invalid intake address or secret." }, 401);

        if (body.externalId) {
          const seen = await alreadyProcessed(source.schema, channel, body.externalId);
          if (seen) return json({ ok: true, duplicate: true, eventId: seen });
        }

        const files: IntakeFile[] = [...(body.files ?? [])];
        if (body.text) {
          files.push({
            name: `${channel}-message.txt`,
            mimeType: "text/plain",
            base64: Buffer.from(body.text, "utf8").toString("base64"),
          });
        }
        if (!files.length) return json({ error: "Send at least one file or some text." }, 400);

        const eventId = await recordIntakeEvent(source.schema, {
          channel,
          externalId: body.externalId ?? null,
          status: "received",
          detail: {
            address: body.address,
            from: body.from ?? null,
            files: files.map((file) => file.name),
          },
        });

        const jobId = await enqueueJob({
          tenantId: source.tenantId,
          kind: "intake.process",
          payload: {
            sourceId: source.id,
            eventId,
            channel,
            externalId: body.externalId ?? null,
            note: body.note ?? `Received by ${channel}${body.from ? ` from ${body.from}` : ""}.`,
            files,
          },
          maxAttempts: 3,
        });

        const run = await runJobById(jobId);
        if (!run.ok) {
          return json({ ok: true, queued: true, eventId, jobId }, 202);
        }
        return json({ ok: true, eventId, jobId });
      },
    },
  },
});
