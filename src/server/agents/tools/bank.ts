import { z } from "zod";

import { sql, table } from "../../db.server";
import { getPartyHistoryTool, searchLedgersTool } from "./matcher";
import { defineTool, ok } from "./types";

export const getKnownPayeeMappingsTool = defineTool({
  name: "get_known_payee_mappings",
  description: "Return the payee-to-ledger mappings remembered from past approvals.",
  kind: "read",
  agents: ["bank_categoriser"],
  schema: z.object({
    payee: z.string().max(160).optional(),
    limit: z.number().int().min(1).max(50).optional(),
  }),
  run: async (args, context) => {
    const limit = args.limit ?? 30;
    const rows = await sql<{
      kind: string;
      scope_key: string;
      mapping: Record<string, unknown> | null;
    }>(
      `select kind, scope_key, mapping from ${table(context.run.schema, "mappings")}
        where status = 'confirmed' and kind in ('vendor_ledger', 'field_default')
        order by updated_at desc limit $1`,
      [limit],
    );
    const needle = args.payee?.toLowerCase().trim();
    const mappings = rows
      .filter((row) => (needle ? row.scope_key.toLowerCase().includes(needle) : true))
      .map((row) => {
        if (row.kind === "vendor_ledger") {
          return {
            payee: row.scope_key,
            ledger: typeof row.mapping?.["ledger"] === "string" ? row.mapping["ledger"] : null,
            fields: {},
          };
        }
        const values = row.mapping?.["values"];
        return {
          payee: row.scope_key,
          ledger: null,
          fields:
            values && typeof values === "object"
              ? Object.fromEntries(
                  Object.entries(values as Record<string, unknown>).filter(
                    (entry): entry is [string, string] => typeof entry[1] === "string",
                  ),
                )
              : {},
        };
      });
    return ok(
      { mappings },
      `${mappings.length} known payee mapping${mappings.length === 1 ? "" : "s"}`,
    );
  },
});

/** Bank lines are matched against records that are still open, not posted ones. */
export const searchOpenBillsTool = defineTool({
  name: "search_open_bills",
  description: "Find open bills that an amount or reference might settle.",
  kind: "read",
  agents: ["bank_categoriser"],
  schema: z.object({
    vendor: z.string().max(160).optional(),
    amount: z.number().min(0).optional(),
    reference: z.string().max(80).optional(),
    limit: z.number().int().min(1).max(10).optional(),
  }),
  run: async (args, context) => {
    const clauses = [`r.status in ('pending_review', 'held')`];
    const params: unknown[] = [];
    if (args.vendor) {
      params.push(`%${args.vendor.toLowerCase()}%`);
      clauses.push(`lower(coalesce(r.fields->>'vendor_name', '')) like $${params.length}`);
    }
    if (args.amount !== undefined) {
      params.push(Math.round(args.amount * 100));
      clauses.push(`abs(r.amount_minor - $${params.length}) <= 100`);
    }
    if (args.reference) {
      params.push(`%${args.reference.toLowerCase()}%`);
      clauses.push(
        `(lower(coalesce(r.fields->>'invoice_number', '')) like $${params.length} or lower(coalesce(r.fields->>'reference_number', '')) like $${params.length})`,
      );
    }
    params.push(args.limit ?? 6);

    const rows = await sql<{
      id: string;
      title: string;
      status: string;
      amount_minor: number;
      vendor: string | null;
      invoice_date: string | null;
      invoice_number: string | null;
    }>(
      `select r.id, r.title, r.status, r.amount_minor,
              r.fields->>'vendor_name' as vendor,
              r.fields->>'invoice_date' as invoice_date,
              r.fields->>'invoice_number' as invoice_number
         from ${table(context.run.schema, "records")} r
        where ${clauses.join(" and ")}
        order by r.created_at asc
        limit $${params.length}`,
      params,
    );
    return ok(
      {
        bills: rows.map((row) => ({
          id: row.id,
          title: row.title,
          status: row.status,
          amountMinor: Number(row.amount_minor),
          vendor: row.vendor,
          invoiceDate: row.invoice_date,
          invoiceNumber: row.invoice_number,
        })),
      },
      `${rows.length} open bill${rows.length === 1 ? "" : "s"}`,
    );
  },
});

export const BANK_TOOLS = [
  getKnownPayeeMappingsTool,
  searchLedgersTool,
  searchOpenBillsTool,
  getPartyHistoryTool,
];
