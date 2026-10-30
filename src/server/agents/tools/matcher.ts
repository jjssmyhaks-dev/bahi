import { z } from "zod";

import { sql, sqlOne, table } from "../../db.server";
import { nameSimilarity } from "../similarity";
import { confirmedVendorLedgers, getMapping, listMasters } from "../store.server";
import { defineTool, fail, ok } from "./types";

export const findPartyByGstinTool = defineTool({
  name: "find_party_by_gstin",
  description: "Exact lookup of a supplier or customer by GSTIN in this workspace's masters.",
  kind: "read",
  agents: ["master_matcher"],
  schema: z.object({ gstin: z.string().min(15).max(15) }),
  run: async (args, context) => {
    const gstin = args.gstin.replace(/\s+/g, "").toUpperCase();
    const row = await sqlOne<{
      id: string;
      name: string;
      gstin: string | null;
      ledger: string | null;
    }>(
      `select id, name, gstin, ledger from ${table(context.run.schema, "masters")}
        where kind = 'vendor' and upper(coalesce(gstin, '')) = $1
        limit 1`,
      [gstin],
    );
    if (!row) return ok({ party: null }, "No party has that GSTIN");
    return ok(
      {
        party: { id: row.id, name: row.name, gstin: row.gstin, ledger: row.ledger },
      },
      `${row.name} matches ${gstin}`,
    );
  },
});

export const searchPartiesTool = defineTool({
  name: "search_parties",
  description:
    "Fuzzy and vector search of supplier names in this workspace's masters. Returns the closest candidates with scores.",
  kind: "read",
  agents: ["master_matcher"],
  schema: z.object({
    query: z.string().max(160).optional(),
    limit: z.number().int().min(1).max(8).optional(),
  }),
  run: async (args, context) => {
    const limit = args.limit ?? 6;
    const masters = await listMasters(context.run.schema, "vendor");
    const query = args.query?.trim() ?? "";
    const scored = masters
      .map((master) => ({
        name: master.name,
        gstin: master.gstin,
        ledger: master.ledger,
        confidence: query ? Number(nameSimilarity(master.name, query).toFixed(3)) : 0.5,
      }))
      .filter((party) => (query ? party.confidence >= 0.3 : true))
      .sort((left, right) => right.confidence - left.confidence)
      .slice(0, limit);
    return ok(
      { parties: scored },
      `${scored.length} party candidate${scored.length === 1 ? "" : "s"}`,
    );
  },
});

export const getRememberedMappingTool = defineTool({
  name: "get_remembered_mapping",
  description:
    "Look up a mapping remembered from a past approval, such as this vendor's ledger or field defaults.",
  kind: "read",
  agents: ["master_matcher"],
  schema: z.object({
    vendor_name: z.string().max(160),
    vendor_gstin: z.string().max(20).optional(),
  }),
  run: async (args, context) => {
    const [ledgers, byGstin, byName] = await Promise.all([
      confirmedVendorLedgers(context.run.schema),
      args.vendor_gstin
        ? getMapping(context.run.schema, "field_default", args.vendor_gstin.toUpperCase())
        : Promise.resolve(null),
      getMapping(context.run.schema, "field_default", args.vendor_name),
    ]);
    const ledger =
      (args.vendor_gstin ? ledgers[args.vendor_gstin.toUpperCase()] : undefined) ??
      ledgers[args.vendor_name] ??
      null;
    const fieldMapping =
      byGstin?.status === "confirmed" ? byGstin : byName?.status === "confirmed" ? byName : null;
    const values = fieldMapping?.mapping["values"];
    const fields =
      values && typeof values === "object"
        ? Object.fromEntries(
            Object.entries(values as Record<string, unknown>).filter(
              (entry): entry is [string, string] => typeof entry[1] === "string",
            ),
          )
        : {};
    if (!ledger && !Object.keys(fields).length) {
      return ok({ mapping: null }, "No remembered mapping for that vendor");
    }
    return ok(
      { mapping: { ledger, fields } },
      ledger ? `Remembered ledger ${ledger}` : "Remembered field defaults",
    );
  },
});

export const searchLedgersTool = defineTool({
  name: "search_ledgers",
  description: "Search ledger names and groups in this workspace's masters.",
  kind: "read",
  agents: ["master_matcher", "bank_categoriser"],
  schema: z.object({
    query: z.string().max(120).optional(),
    limit: z.number().int().min(1).max(10).optional(),
  }),
  run: async (args, context) => {
    const limit = args.limit ?? 6;
    const masters = await listMasters(context.run.schema, "ledger");
    const query = args.query?.trim() ?? "";
    const scored = masters
      .map((master) => ({
        name: master.name,
        confidence: query ? Number(nameSimilarity(master.name, query).toFixed(3)) : 0.5,
      }))
      .filter((ledger) => (query ? ledger.confidence >= 0.25 : true))
      .sort((left, right) => right.confidence - left.confidence)
      .slice(0, limit);
    return ok(
      { ledgers: scored },
      `${scored.length} ledger candidate${scored.length === 1 ? "" : "s"}`,
    );
  },
});

export const searchStockItemsTool = defineTool({
  name: "search_stock_items",
  description: "Search stock items or services by name, unit and tax rate.",
  kind: "read",
  agents: ["master_matcher"],
  schema: z.object({
    query: z.string().max(120).optional(),
    unit: z.string().max(20).optional(),
    limit: z.number().int().min(1).max(10).optional(),
  }),
  run: async (args, context) => {
    const limit = args.limit ?? 6;
    const rows = await sql<{ id: string; name: string; data: Record<string, unknown> | null }>(
      `select id, name, data from ${table(context.run.schema, "masters")}
        where kind = 'item' order by name asc`,
    );
    const query = args.query?.trim() ?? "";
    const items = rows
      .map((row) => ({
        name: row.name,
        unit: typeof row.data?.["unit"] === "string" ? String(row.data["unit"]) : null,
        taxRate: typeof row.data?.["taxRate"] === "number" ? Number(row.data["taxRate"]) : null,
        confidence: query ? Number(nameSimilarity(row.name, query).toFixed(3)) : 0.5,
      }))
      .filter((item) => (args.unit ? item.unit?.toLowerCase() === args.unit.toLowerCase() : true))
      .filter((item) => (query ? item.confidence >= 0.3 : true))
      .sort((left, right) => right.confidence - left.confidence)
      .slice(0, limit);
    return ok({ items }, `${items.length} stock item candidate${items.length === 1 ? "" : "s"}`);
  },
});

export const getPartyHistoryTool = defineTool({
  name: "get_party_history",
  description:
    "Summarise how this party was handled before: volume, usual ledger, tax details and counts.",
  kind: "read",
  agents: ["master_matcher", "bank_categoriser"],
  schema: z.object({
    vendor_name: z.string().min(1).max(160),
    vendor_gstin: z.string().max(20).optional(),
  }),
  run: async (args, context) => {
    const gstin = args.vendor_gstin?.replace(/\s+/g, "").toUpperCase() ?? null;
    const summary = await sqlOne<{
      records: number;
      total_minor: number;
      last_seen: string | null;
      last_invoice_date: string | null;
      doc_types: string[] | null;
      place_of_supply: string | null;
    }>(
      `select count(*)::int as records,
              coalesce(sum(amount_minor), 0)::bigint as total_minor,
              max(created_at) as last_seen,
              max(fields->>'invoice_date') as last_invoice_date,
              array_agg(distinct doc_type) as doc_types,
              max(fields->>'place_of_supply') as place_of_supply
         from ${table(context.run.schema, "records")}
        where lower(coalesce(fields->>'vendor_name', '')) = lower($1)
           or ($2::text is not null and upper(coalesce(fields->>'vendor_gstin', '')) = $2)`,
      [args.vendor_name, gstin],
    );
    const master = await sqlOne<{ ledger: string | null; gstin: string | null }>(
      `select ledger, gstin from ${table(context.run.schema, "masters")}
        where kind = 'vendor' and lower(name) = lower($1) limit 1`,
      [args.vendor_name],
    );
    const ledgers = await confirmedVendorLedgers(context.run.schema);
    const corrections = await sqlOne<{ n: number }>(
      `select count(*)::int as n from ${table(context.run.schema, "corrections")}
        where lower(coalesce(vendor_key, '')) = lower($1)`,
      [args.vendor_name],
    );
    const ledger =
      (gstin ? ledgers[gstin] : undefined) ?? ledgers[args.vendor_name] ?? master?.ledger ?? null;
    const total = Number(summary?.total_minor ?? 0);
    return ok(
      {
        vendorName: args.vendor_name,
        records: Number(summary?.records ?? 0),
        totalSpendMinor: total,
        lastSeen: summary?.last_seen ?? null,
        lastInvoiceDate: summary?.last_invoice_date ?? null,
        docTypes: summary?.doc_types ?? [],
        usualLedger: ledger,
        gstin: gstin ?? master?.gstin ?? null,
        placeOfSupply: summary?.place_of_supply ?? null,
        corrections: Number(corrections?.n ?? 0),
      },
      `${Number(summary?.records ?? 0)} past record${Number(summary?.records ?? 0) === 1 ? "" : "s"}`,
    );
  },
});

export const MATCHER_TOOLS = [
  findPartyByGstinTool,
  searchPartiesTool,
  getRememberedMappingTool,
  searchLedgersTool,
  searchStockItemsTool,
  getPartyHistoryTool,
];
