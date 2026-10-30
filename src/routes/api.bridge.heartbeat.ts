import { createFileRoute } from "@tanstack/react-router";

import {
  authenticateBridgeToken,
  bearerToken,
  bridgeJson,
  touchBridgeAgent,
} from "@/server/bridge.server";

export const Route = createFileRoute("/api/bridge/heartbeat")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const token = bearerToken(request);
        const agent = token ? await authenticateBridgeToken(token) : null;
        if (!agent) return bridgeJson({ error: "Invalid or revoked bridge token." }, 401);

        let body: { version?: unknown; tallyUrl?: unknown; lastError?: unknown } = {};
        try {
          body = (await request.json()) as typeof body;
        } catch {
          // A bare heartbeat is valid.
        }
        await touchBridgeAgent(agent.agentId, {
          version: typeof body.version === "string" ? body.version.slice(0, 40) : null,
          tallyUrl: typeof body.tallyUrl === "string" ? body.tallyUrl.slice(0, 500) : null,
          lastError: typeof body.lastError === "string" ? body.lastError.slice(0, 500) : null,
        });
        return bridgeJson({
          ok: true,
          agent: { id: agent.agentId, label: agent.label, companyName: agent.companyName },
          serverTime: new Date().toISOString(),
        });
      },
    },
  },
});
