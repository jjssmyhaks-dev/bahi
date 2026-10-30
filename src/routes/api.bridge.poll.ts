import { createFileRoute } from "@tanstack/react-router";

import {
  authenticateBridgeToken,
  bearerToken,
  bridgeJson,
  pollBridgeCommands,
  touchBridgeAgent,
} from "@/server/bridge.server";

export const Route = createFileRoute("/api/bridge/poll")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const token = bearerToken(request);
        const agent = token ? await authenticateBridgeToken(token) : null;
        if (!agent) return bridgeJson({ error: "Invalid or revoked bridge token." }, 401);

        let body: { limit?: unknown; version?: unknown; tallyUrl?: unknown } = {};
        try {
          body = (await request.json()) as typeof body;
        } catch {
          // A poll without a body is valid: the agent just wants the next batch.
        }
        await touchBridgeAgent(agent.agentId, {
          version: typeof body.version === "string" ? body.version.slice(0, 40) : null,
          tallyUrl: typeof body.tallyUrl === "string" ? body.tallyUrl.slice(0, 500) : null,
        });
        const limit = typeof body.limit === "number" ? body.limit : undefined;
        const response = await pollBridgeCommands(agent, limit);
        return bridgeJson(response);
      },
    },
  },
});
