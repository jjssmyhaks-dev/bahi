import { describe, expect, it } from "vitest";

import type { DocType, FieldMap, RecordRow } from "@/lib/types";
import { parseCsv, parseGstr2b } from "@/server/gstr2b.server";
import { evaluateThreeWay } from "@/server/matching.server";
import { buildTallyVoucher, postTally, tallyXml } from "@/server/posting.server";

function record(docType: DocType, fields: FieldMap, id = "rec-1"): RecordRow {
  return {
    id,
    chatId: null,
    documentId: null,
    docType,
    title: "Test document",
    fields,
    confidences: {},
    validation: [],
    overallConfidence: 0.95,
    status: "pending_review",
    destination: "tally",
    destinationRef: null,
    destinationNote: null,
    reason: null,
    priority: 50,
    amountMinor: 0,
    idempotencyKey: `idem-${id}`,
    groupKey: null,
    assignedTo: null,
    assignedToName: null,
    dueAt: null,
    reviewReason: null,
    locations: {},
    evidence: {},
    shadow: false,
    sourceChannel: "chat",
    postedAt: null,
    reviewedAt: null,
    createdAt: "2026-04-12T00:00:00.000Z",
    updatedAt: "2026-04-12T00:00:00.000Z",
    envelope: {},
    agentMode: "deterministic",
    permissionLevel: null,
    approvedPermissionLevel: null,
  };
}

const supplierInvoice = () =>
  record("supplier_invoice", {
    vendor_name: "Acme Steels",
    vendor_gstin: "27AAPFU0939F1ZV",
    invoice_number: "INV-104",
    invoice_date: "2026-04-12",
    taxable_value: 10_000,
    cgst: 900,
    sgst: 900,
    total: 11_800,
  });

describe("Tally voucher mapping", () => {
  it("maps a supplier invoice with GST to a balanced purchase voucher", () => {
    const payload = buildTallyVoucher(supplierInvoice(), "Acme Pvt Ltd");
    expect(payload.voucherType).toBe("Purchase");
    expect(payload.reference).toBe("INV-104");
    expect(payload.partyGstin).toBe("27AAPFU0939F1ZV");
    expect(payload.entries).toEqual(
      expect.arrayContaining([
        { ledger: "Purchase @ 18%", amount: 10_000, direction: "debit" },
        { ledger: "Input CGST", amount: 900, direction: "debit" },
        { ledger: "Input SGST", amount: 900, direction: "debit" },
        { ledger: "Acme Steels", amount: 11_800, direction: "credit" },
      ]),
    );
  });

  it("reduces the party credit and adds TDS payable when TDS is deducted", () => {
    const invoice = supplierInvoice();
    invoice.fields.tds_amount = 200;
    invoice.fields.tds_section = "194Q";
    const payload = buildTallyVoucher(invoice, "Acme Pvt Ltd");
    const party = payload.entries.find((entry) => entry.ledger === "Acme Steels");
    expect(party).toMatchObject({ amount: 11_600, direction: "credit" });
    expect(payload.entries).toContainEqual({
      ledger: "TDS Payable",
      amount: 200,
      direction: "credit",
    });
    const debit = payload.entries
      .filter((entry) => entry.direction === "debit")
      .reduce((sum, entry) => sum + entry.amount, 0);
    const credit = payload.entries
      .filter((entry) => entry.direction === "credit")
      .reduce((sum, entry) => sum + entry.amount, 0);
    expect(debit).toBeCloseTo(credit, 2);
    expect(payload.narration).toContain("TDS 194Q");
  });

  it("mirrors a credit note into a purchase return", () => {
    const payload = buildTallyVoucher(
      record("credit_note", {
        vendor_name: "Acme Steels",
        taxable_value: 1_000,
        cgst: 90,
        sgst: 90,
        total: 1_180,
        invoice_number: "CN-9",
      }),
      "Acme Pvt Ltd",
    );
    expect(payload.voucherType).toBe("Credit Note");
    expect(payload.entries).toEqual([
      { ledger: "Acme Steels", amount: 1_180, direction: "debit" },
      { ledger: "Purchase Return @ 18%", amount: 1_000, direction: "credit" },
      { ledger: "Input CGST", amount: 90, direction: "credit" },
      { ledger: "Input SGST", amount: 90, direction: "credit" },
    ]);
  });

  it("sends inventory allocations for a purchase order", () => {
    const payload = buildTallyVoucher(
      record("purchase_order", {
        vendor_name: "Acme Steels",
        po_number: "PO-7",
        vendor_gstin: "27AAPFU0939F1ZV",
        line_items: [
          {
            description: "MS Angle 50x50",
            quantity: 10,
            rate: 500,
            amount: 5_000,
            unit: "Kg",
            hsn: "7216",
          },
        ],
      }),
      "Acme Pvt Ltd",
    );
    expect(payload.voucherType).toBe("Purchase Order");
    expect(payload.total).toBe(5_000);
    expect(payload.inventory).toEqual([
      {
        item: "MS Angle 50x50",
        quantity: 10,
        rate: 500,
        amount: 5_000,
        unit: "Kg",
        hsn: "7216",
      },
    ]);
    const xml = tallyXml(payload);
    expect(xml).toContain("<INVENTORYALLOCATIONS.LIST>");
    expect(xml).toContain("<STOCKITEMNAME>MS Angle 50x50</STOCKITEMNAME>");
    expect(xml).toContain("<HSNCODE>7216</HSNCODE>");
    expect(xml).toContain("<ACTUALQTY>10 Kg</ACTUALQTY>");
  });

  it("adds a voucher number, GSTIN and reference to the posted XML", async () => {
    const posted = await postTally("bahi_t_demo", supplierInvoice(), "Acme Pvt Ltd");
    expect(posted.status).toBe("posted");
    expect(posted.externalRef).toMatch(/^BAHI\/\d{6}\//);
    const xml = String((posted.payload as { xml: string }).xml);
    expect(xml).toContain("<VOUCHERNUMBER>");
    expect(xml).toContain("<PARTYGSTIN>27AAPFU0939F1ZV</PARTYGSTIN>");
    expect(xml).toContain("<REFERENCE>INV-104</REFERENCE>");
  });
});

describe("three-way matching", () => {
  const invoice = {
    vendor_gstin: "27AAPFU0939F1ZV",
    vendor_name: "Acme Steels",
    po_number: "PO-7",
    total: 11_800,
    line_items: [{ description: "MS Angle", quantity: 10, amount: 10_000 }],
  };

  it("matches a purchase order and goods receipt for the same supplier and amount", () => {
    const evidence = evaluateThreeWay(invoice, [
      {
        id: "po-1",
        docType: "purchase_order",
        title: "PO 7",
        fields: {
          po_number: "PO-7",
          vendor_gstin: "27AAPFU0939F1ZV",
          total: 11_800,
          line_items: [{ description: "MS Angle 50x50", quantity: 10, amount: 10_000 }],
        },
      },
      {
        id: "gr-1",
        docType: "goods_receipt",
        title: "GR 7",
        fields: { po_number: "PO-7", vendor_gstin: "27AAPFU0939F1ZV", total: 11_800 },
      },
    ]);
    expect(evidence.poMatched).toBe(true);
    expect(evidence.grMatched).toBe(true);
    expect(evidence.poRecordId).toBe("po-1");
    expect(evidence.grRecordId).toBe("gr-1");
    expect(evidence.poReason).toContain("PO-7");
  });

  it("flags a purchase order whose amount differs beyond tolerance", () => {
    const evidence = evaluateThreeWay(invoice, [
      {
        id: "po-2",
        docType: "purchase_order",
        title: "PO 7",
        fields: {
          po_number: "PO-7",
          vendor_gstin: "27AAPFU0939F1ZV",
          total: 20_000,
          line_items: [{ description: "MS Angle", quantity: 10, amount: 10_000 }],
        },
      },
    ]);
    expect(evidence.poMatched).toBe(false);
    expect(evidence.grMatched).toBe(false);
    expect(evidence.poReason).toContain("differs");
    expect(evidence.varianceMinor).toBeGreaterThan(0);
  });

  it("waits for a purchase order when the invoice names one that is not uploaded", () => {
    const evidence = evaluateThreeWay({ ...invoice, po_number: "PO-404" }, []);
    expect(evidence.poMatched).toBe(false);
    expect(evidence.poReason).toContain("not among the uploaded records");
    expect(evidence.grReason).toContain("waits for a purchase order");
  });
});

describe("GSTR-2B parsing", () => {
  it("splits quoted CSV cells", () => {
    expect(parseCsv('a,"b,1","c ""q"""\n1,2,3')).toEqual([
      ["a", "b,1", 'c "q"'],
      ["1", "2", "3"],
    ]);
  });

  it("reads a CSV export", () => {
    const csv = [
      "Supplier GSTIN,Invoice Number,Invoice Date,Taxable Value,CGST,SGST,IGST,Total",
      "27aapfu0939f1zv,INV-104,12-04-2026,10000,900,900,0,11800",
    ].join("\r\n");
    const lines = parseGstr2b(csv, "gstr2b.csv", "2026-04");
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({
      period: "2026-04",
      supplierGstin: "27AAPFU0939F1ZV",
      invoiceNumber: "INV-104",
      invoiceDate: "2026-04-12",
      taxable: 10_000,
      cgst: 900,
      sgst: 900,
      total: 11_800,
    });
  });

  it("reads the portal JSON with nested invoice bundles", () => {
    const json = JSON.stringify({
      data: {
        docdata: {
          b2b: [
            {
              ctin: "27AAPFU0939F1ZV",
              trdnm: "Acme Steels",
              inv: [
                {
                  inum: "INV-104",
                  dt: "12-04-2026",
                  val: 11800,
                  txval: 10000,
                  camt: 900,
                  samt: 900,
                  iamt: 0,
                },
              ],
            },
          ],
        },
      },
    });
    const lines = parseGstr2b(json, "gstr2b.json");
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({
      supplierGstin: "27AAPFU0939F1ZV",
      supplierName: "Acme Steels",
      invoiceNumber: "INV-104",
      period: "2026-04",
      total: 11_800,
    });
  });
});
