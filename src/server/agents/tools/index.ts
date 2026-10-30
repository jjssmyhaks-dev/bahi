import type { AgentId } from "../types";
import { BANK_TOOLS } from "./bank";
import { CLASSIFIER_TOOLS } from "./classifier";
import { CURATOR_TOOLS } from "./curator";
import { EXTRACTION_TOOLS } from "./extraction";
import { MAPPER_TOOLS } from "./mapper";
import { MATCHER_TOOLS } from "./matcher";
import { ORCHESTRATOR_TOOLS } from "./orchestrator";
import type { ToolDefinition } from "./types";

/**
 * The only tools each agent may call, exactly as the build specification lists
 * them. The runner registers nothing outside this map.
 */
export const TOOL_CATALOGUE: Record<AgentId, readonly ToolDefinition[]> = {
  chat_orchestrator: ORCHESTRATOR_TOOLS,
  document_classifier: CLASSIFIER_TOOLS,
  extraction: EXTRACTION_TOOLS,
  master_matcher: MATCHER_TOOLS,
  validation_explainer: [],
  destination_mapper: MAPPER_TOOLS,
  bank_categoriser: BANK_TOOLS,
  learning_curator: CURATOR_TOOLS,
};

export const TOOL_NAMES_BY_AGENT: Record<AgentId, readonly string[]> = {
  chat_orchestrator: [
    "start_processing",
    "get_batch_status",
    "get_document_status",
    "get_record_card",
    "list_needs_attention",
    "apply_correction",
    "approve_records",
    "reject_records",
    "hold_records",
    "explain_flag",
    "list_destinations",
    "connect_destination",
    "list_sheets",
    "find_records",
    "request_better_document",
    "get_usage_summary",
  ],
  document_classifier: ["get_pack_document_types", "get_page_images"],
  extraction: ["get_extraction_schema", "get_similar_examples", "get_field_crop", "get_ocr_text"],
  master_matcher: [
    "find_party_by_gstin",
    "search_parties",
    "get_remembered_mapping",
    "search_ledgers",
    "search_stock_items",
    "get_party_history",
  ],
  validation_explainer: [],
  destination_mapper: ["inspect_sheet_headers", "get_record_field_list", "get_confirmed_mapping"],
  bank_categoriser: [
    "get_known_payee_mappings",
    "search_ledgers",
    "search_open_bills",
    "get_party_history",
  ],
  learning_curator: ["get_correction_groups", "get_existing_rules"],
};

export function toolsForAgent(agent: AgentId): readonly ToolDefinition[] {
  return TOOL_CATALOGUE[agent];
}

/**
 * Returns a list of catalogue problems. Tests fail when this is non-empty:
 * a duplicate name with different definitions, a tool registered on an agent
 * that is not in its own allow list, or a JSON schema that accepts identity.
 */
export function validateToolCatalogue(): string[] {
  const problems: string[] = [];
  const seen = new Map<string, ToolDefinition>();

  for (const [agent, tools] of Object.entries(TOOL_CATALOGUE) as [
    AgentId,
    readonly ToolDefinition[],
  ][]) {
    const expected = new Set(TOOL_NAMES_BY_AGENT[agent]);
    const registered = new Set(tools.map((tool) => tool.name));

    for (const name of expected) {
      if (!registered.has(name)) problems.push(`${agent} is missing tool ${name}`);
    }
    for (const name of registered) {
      if (!expected.has(name)) problems.push(`${agent} registers an unlisted tool ${name}`);
    }

    for (const tool of tools) {
      if (!tool.agents.includes(agent)) {
        problems.push(`${tool.name} is registered on ${agent} but does not allow it`);
      }
      const existing = seen.get(tool.name);
      if (existing && existing !== tool) {
        problems.push(`${tool.name} has more than one definition`);
      }
      seen.set(tool.name, tool);

      const properties = (tool.parameters as { properties?: Record<string, unknown> }).properties;
      for (const key of ["tenant_id", "tenantId", "user_id", "userId", "schema", "schema_name"]) {
        if (properties && key in properties) {
          problems.push(`${tool.name} exposes ${key} to the model`);
        }
      }
    }
  }

  return problems;
}
