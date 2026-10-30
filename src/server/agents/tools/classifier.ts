import { z } from "zod";

import { DOC_TYPE_LABELS } from "@/lib/format";
import type { DocType } from "@/lib/types";
import { sqlOne, table } from "../../db.server";
import { packFor } from "../pack";
import { defineTool, fail, ok } from "./types";

const DESCRIPTIONS: Record<DocType, string> = {
  supplier_invoice: "A tax invoice issued by a supplier for goods or services.",
  credit_note: "A supplier credit note that reverses or reduces an earlier invoice.",
  purchase_order: "A buyer's order to a supplier, usually without tax amounts.",
  goods_receipt: "A delivery challan or receipt note for goods received.",
  e_way_bill: "An e-way bill covering the movement of goods.",
  e_invoice: "An invoice carrying an IRN and QR code under e-invoicing.",
  bank_statement: "A bank account statement listing transactions.",
};

export const getPackDocumentTypesTool = defineTool({
  name: "get_pack_document_types",
  description:
    "List the document types in this workspace's active industry pack, with a short description of each.",
  kind: "read",
  agents: ["document_classifier"],
  schema: z.object({}),
  run: async (_args, context) => {
    const pack = packFor(context.run);
    const types = pack.catalogue.map((type) => ({
      type,
      label: DOC_TYPE_LABELS[type],
      description: DESCRIPTIONS[type],
    }));
    return ok(
      { pack: pack.name, version: pack.version, types },
      `${types.length} document types in ${pack.name}`,
    );
  },
});

/**
 * The server loads the pages; the model never supplies file bytes. Image
 * rasterisation is not part of this build, so the text layer is returned with
 * an explicit note instead of pretending an image exists.
 */
export const getPageImagesTool = defineTool({
  name: "get_page_images",
  description:
    "Return the pages of one uploaded file with its embedded text, loaded by the server. Use the document id from the run context.",
  kind: "read",
  agents: ["document_classifier"],
  schema: z.object({
    document_id: z.string().uuid().optional(),
    max_pages: z.number().int().min(1).max(30).optional(),
  }),
  run: async (args, context) => {
    const documentId = args.document_id ?? context.run.documentId;
    if (!documentId) return fail("not_found", "No document is attached to this run.");
    const row = await sqlOne<{
      id: string;
      filename: string;
      page_count: number | null;
      extracted_text: string | null;
    }>(
      `select id, filename, page_count, extracted_text
         from ${table(context.run.schema, "documents")} where id = $1`,
      [documentId],
    );
    if (!row) return fail("not_found", "That document is not in this workspace.");
    if (!row.extracted_text?.trim()) {
      return fail("unavailable", "This file has no readable text layer.");
    }
    const limit = args.max_pages ?? 12;
    const pages = row.extracted_text
      .split("\f")
      .slice(0, limit)
      .map((text, index) => ({ page: index + 1, text: text.trim().slice(0, 6_000) }));
    return ok(
      {
        documentId: row.id,
        filename: row.filename,
        pageCount: row.page_count ?? pages.length,
        imagesAvailable: false,
        note: "Page images are not rasterised in this build; the embedded text layer is returned.",
        pages,
      },
      `${pages.length} page${pages.length === 1 ? "" : "s"} from ${row.filename}`,
    );
  },
});

export const CLASSIFIER_TOOLS = [getPackDocumentTypesTool, getPageImagesTool];
