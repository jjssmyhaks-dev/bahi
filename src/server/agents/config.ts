import { env } from "../env.server";
import type { AgentId } from "./types";

export type ModelTier = "small" | "large";

export interface AgentPolicy {
  tier: ModelTier;
  /** Sampling temperature. Deterministic agents still use a low value in model mode. */
  temperature: number;
  maxTokens: number;
  timeoutMs: number;
}

/**
 * Model name and tier per agent. None of this is a constant: change the env
 * vars and every agent follows. Without AI_API_KEY the deterministic path runs.
 */
export const AGENT_POLICIES: Record<AgentId, AgentPolicy> = {
  chat_orchestrator: { tier: "small", temperature: 0.1, maxTokens: 600, timeoutMs: 20_000 },
  document_classifier: { tier: "small", temperature: 0, maxTokens: 900, timeoutMs: 30_000 },
  extraction: { tier: "large", temperature: 0, maxTokens: 2_400, timeoutMs: 60_000 },
  master_matcher: { tier: "small", temperature: 0.1, maxTokens: 500, timeoutMs: 20_000 },
  validation_explainer: { tier: "small", temperature: 0.2, maxTokens: 900, timeoutMs: 20_000 },
  destination_mapper: { tier: "small", temperature: 0, maxTokens: 800, timeoutMs: 20_000 },
  bank_categoriser: { tier: "small", temperature: 0.1, maxTokens: 900, timeoutMs: 30_000 },
  learning_curator: { tier: "small", temperature: 0.2, maxTokens: 1_200, timeoutMs: 30_000 },
};

export const AGENT_LIMITS = {
  maxPromptChars: 24_000,
  maxRetrievedExamples: 3,
  maxCandidates: 6,
  maxCorrectionGroups: 40,
  retryCount: 1,
  networkAttempts: 3,
  /** A confused model cannot loop forever; writes stop when the budget is spent. */
  maxToolCalls: 8,
};

export function agentsEnabled(): boolean {
  return Boolean(env.ai.apiKey);
}

export function modelFor(agent: AgentId): string {
  return AGENT_POLICIES[agent].tier === "large" ? env.ai.modelLarge : env.ai.modelSmall;
}
