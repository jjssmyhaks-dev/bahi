import { createFileRoute } from "@tanstack/react-router";

import {
  ackBridgeCommands,
  authenticateBridgeToken,
  bearerToken,
  bridgeJson,
  touchBridgeAgent,
  type AckResult,
} from "@/server/bridge.server";

function parseResults(input: unknown): AckResult[] {
  if (!Array.isArray(input)) return [];
  return input.slice(0, 100).flatMap((entry) => {
    if (!entry || typeof entry !== "object") return [];
    const item = entry as Record<string, unknown>;
    if (typeof item.id !== "string" || (item.status !== "acked" && item.status !== "failed")) {
      return [];
    }
    return [
      {
        id: item.id,
        status: item.status,
        ...(item.result && typeof item.result === "object"
          ? { result: item.result as Record<string, unknown> }
          : {}),
        ...(typeof item.error === "string" ? { error: item.error.slice(0, 1_000) } : {}),
      },
    ];
  });
}

export const Route = createFileRoute("/api/bridge/ack")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const token = bearerToken(request);
        const agent = token ? await authenticateBridgeToken(token) : null;
        if (!agent) return bridgeJson({ error: "Invalid or revoked bridge token." }, 401);

        let body: { results?: unknown; version?: unknown; lastError?: unknown };
        try {
          body = (await request.json()) as typeof body;
        } catch {
          return bridgeJson({ error: "Send JSON with a results array." }, 400);
        }
        const results = parseResults(body.results);
        await touchBridgeAgent(agent.agentId, {
          version: typeof body.version === "string" ? body.version.slice(0, 40) : null,
          lastError: typeof body.lastError === "string" ? body.lastError.slice(0, 500) : null,
        });
        if (!results.length) return bridgeJson({ accepted: 0, rejected: 0 });
        const outcome = await ackBridgeCommands(agent, results);
        return bridgeJson(outcome);
      },
    },
  },
});
