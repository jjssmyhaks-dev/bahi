import type { Destination, RecordRow, SessionUser } from "@/lib/types";
import { bridgeHealth, enqueueBridgeCommand, queueCancelVoucher } from "./bridge.server";
import { sqlOne, table } from "./db.server";
import { googleSheetHealth } from "./google.server";
import { buildTallyVoucher, markExcelWritten, writeSheet } from "./posting.server";
import { getRecord } from "./repo.server";
import type { WorkflowOutcome } from "./workflow.server";

export type ConnectorHealthStatus = "connected" | "needs_sign_in" | "available" | "offline";

export interface ConnectorHealth {
  status: ConnectorHealthStatus;
  detail: string;
}

export interface ConnectorValidation {
  ok: boolean;
  problems: string[];
}

export interface ConnectorWrite {
  externalRef: string;
  note: string;
  payload: Record<string, unknown>;
  queued?: boolean;
  commandId?: string;
}

/**
 * Every destination implements this interface so adding one never changes the
 * engine. Agents cannot reach a connector; only the workflow calls it.
 */
export interface DestinationConnector {
  id: Destination;
  validatePayload(
    session: SessionUser,
    record: RecordRow,
    company: string,
  ): Promise<ConnectorValidation>;
  write(
    session: SessionUser,
    record: RecordRow,
    company: string,
    idempotencyKey: string,
  ): Promise<WorkflowOutcome<ConnectorWrite>>;
  confirm(
    session: SessionUser,
    recordId: string,
    externalRef: string,
  ): Promise<WorkflowOutcome<{ confirmed: boolean; detail: string }>>;
  rollback(
    session: SessionUser,
    recordId: string,
    externalRef: string,
  ): Promise<WorkflowOutcome<{ rolledBack: boolean; message: string }>>;
  health(session: SessionUser, company: string): Promise<ConnectorHealth>;
}

function missingFields(record: RecordRow): string[] {
  const problems: string[] = [];
  if (!String(record.fields.vendor_name ?? "").trim() && record.docType !== "bank_statement") {
    problems.push("The supplier name is missing.");
  }
  if (record.amountMinor <= 0) problems.push("The amount must be greater than zero.");
  return problems;
}

async function posted(session: SessionUser, recordId: string, destination: Destination) {
  return sqlOne<{ status: string; external_ref: string | null }>(
    `select status, external_ref from ${table(session.schema, "posts")}
      where record_id = $1 and destination = $2 order by created_at desc limit 1`,
    [recordId, destination],
  );
}

function unreversible(
  destination: string,
): WorkflowOutcome<{ rolledBack: boolean; message: string }> {
  return {
    ok: false,
    code: "unavailable",
    message: `${destination} writes cannot be reversed from this build. Reverse the entry in the destination itself.`,
  };
}

const tallyConnector: DestinationConnector = {
  id: "tally",
  async validatePayload(_session, record) {
    const problems = missingFields(record);
    if (!record.fields.invoice_number && record.docType !== "bank_statement") {
      problems.push("The voucher needs a document number.");
    }
    return { ok: problems.length === 0, problems };
  },
  async write(session, record, company, idempotencyKey) {
    if (!idempotencyKey.trim()) {
      return { ok: false, code: "invalid", message: "The write needs an idempotency key." };
    }
    let voucher;
    try {
      voucher = buildTallyVoucher(record, company);
    } catch (error) {
      return {
        ok: false,
        code: "failed",
        message: error instanceof Error ? error.message : "The Tally voucher could not be built.",
      };
    }
    const draft = session.autonomyMode === "draft";
    const queued = await enqueueBridgeCommand(session, {
      type: draft ? "post_voucher_draft" : "post_voucher",
      idempotencyKey,
      payload: { voucher },
      recordId: record.id,
    });
    if (!queued.queued) {
      return { ok: false, code: "unavailable", message: queued.message };
    }
    return {
      ok: true,
      data: {
        externalRef: "",
        note: draft
          ? "Queued to the Tally bridge as a draft voucher."
          : "Queued to the Tally bridge. The voucher number appears after the agent acknowledges.",
        payload: voucher as unknown as Record<string, unknown>,
        queued: true,
        commandId: queued.commandId,
      },
    };
  },
  async confirm(session, recordId) {
    const row = await posted(session, recordId, "tally");
    if (!row) return { ok: true, data: { confirmed: false, detail: "No voucher was recorded." } };
    if (row.status === "queued") {
      return {
        ok: true,
        data: {
          confirmed: false,
          detail:
            "The voucher is still with the bridge agent. It will confirm after acknowledgement.",
        },
      };
    }
    return {
      ok: true,
      data: {
        confirmed: row.status === "posted",
        detail: row.external_ref ? `Voucher ${row.external_ref}.` : `Write is ${row.status}.`,
      },
    };
  },
  async rollback(session, recordId) {
    const row = await posted(session, recordId, "tally");
    if (!row) {
      return { ok: false, code: "not_found", message: "No Tally voucher was recorded." };
    }
    if (!row.external_ref) {
      return {
        ok: false,
        code: "unavailable",
        message: "Tally has not returned a voucher number yet, so it cannot be reversed.",
      };
    }
    const record = await getRecord(session.schema, recordId);
    const queued = await queueCancelVoucher(session, {
      recordId,
      voucherNumber: row.external_ref,
      ...(record ? { voucherType: buildTallyVoucher(record, session.tenantName).voucherType } : {}),
      reason: "Reversed from Bahi",
    });
    if (!queued.queued) return { ok: false, code: "unavailable", message: queued.message };
    await sqlOne(
      `update ${table(session.schema, "records")}
          set destination_note = 'Reversal queued for the Tally bridge.'
        where id = $1`,
      [recordId],
    );
    return {
      ok: true,
      data: { rolledBack: true, message: "Reversal queued. Tally will cancel the voucher." },
    };
  },
  async health(session) {
    const health = await bridgeHealth(session);
    return {
      status: health.status === "none" ? "needs_sign_in" : health.status,
      detail: health.detail,
    };
  },
};

const sheetConnector: DestinationConnector = {
  id: "google_sheets",
  async validatePayload(session, record) {
    const problems = missingFields(record);
    const health = await googleSheetHealth(session);
    if (health.status !== "connected") problems.push(health.detail);
    return { ok: problems.length === 0, problems };
  },
  async write(session, record) {
    try {
      const result = await writeSheet(session.schema, record);
      return {
        ok: true,
        data: {
          externalRef: result.externalRef,
          note: result.note,
          payload: result.payload,
        },
      };
    } catch (error) {
      return {
        ok: false,
        code: "unavailable",
        message: error instanceof Error ? error.message : "The sheet write failed.",
      };
    }
  },
  async confirm(session, recordId) {
    const row = await posted(session, recordId, "google_sheets");
    if (!row) return { ok: true, data: { confirmed: false, detail: "No sheet row was recorded." } };
    return {
      ok: true,
      data: {
        confirmed: row.status === "posted",
        detail: row.external_ref ? `Row ${row.external_ref}.` : `Write is ${row.status}.`,
      },
    };
  },
  async rollback(session, recordId) {
    const row = await sqlOne<{ row_number: number; connection_id: string }>(
      `select row_number, connection_id from ${table(session.schema, "sheet_rows")}
        where record_id = $1 order by created_at desc limit 1`,
      [recordId],
    );
    if (!row) return { ok: false, code: "not_found", message: "No sheet row was recorded." };
    try {
      const { deleteSheetRow } = await import("./google.server");
      await deleteSheetRow(session.schema, Number(row.row_number));
      await sqlOne(`delete from ${table(session.schema, "sheet_rows")} where record_id = $1`, [
        recordId,
      ]);
      await sqlOne(
        `update ${table(session.schema, "posts")}
            set reversed_at = now(), reversal_ref = $2
          where record_id = $1 and destination = 'google_sheets' and reversed_at is null`,
        [recordId, `row ${row.row_number}`],
      );
      await sqlOne(
        `update ${table(session.schema, "records")}
            set status = 'approved', posted_at = null,
                destination_note = 'The sheet row was removed. Approve again to append a new row.'
          where id = $1`,
        [recordId],
      );
      return { ok: true, data: { rolledBack: true, message: "The sheet row was removed." } };
    } catch (error) {
      return {
        ok: false,
        code: "failed",
        message: error instanceof Error ? error.message : "The sheet row could not be removed.",
      };
    }
  },
  async health(session) {
    const health = await googleSheetHealth(session);
    return {
      status:
        health.status === "connected"
          ? "connected"
          : health.status === "not_configured"
            ? "offline"
            : "needs_sign_in",
      detail: health.detail,
    };
  },
};

const excelConnector: DestinationConnector = {
  id: "excel",
  async validatePayload(_session, record) {
    const problems = missingFields(record);
    return { ok: problems.length === 0, problems };
  },
  async write(session, record) {
    const result = await markExcelWritten(session.schema, record);
    return {
      ok: true,
      data: {
        externalRef: result.externalRef,
        note: result.note,
        payload: result.payload,
      },
    };
  },
  async confirm(session, recordId) {
    const row = await sqlOne<{ status: string; destination_ref: string | null }>(
      `select status, destination_ref from ${table(session.schema, "records")} where id = $1`,
      [recordId],
    );
    if (!row) return { ok: true, data: { confirmed: false, detail: "Record not found." } };
    return {
      ok: true,
      data: {
        confirmed: row.status === "written",
        detail: row.destination_ref ?? `Record is ${row.status}.`,
      },
    };
  },
  async rollback() {
    return unreversible("Excel");
  },
  async health() {
    return {
      status: "available",
      detail: "Workbooks are generated from the record or the review queue.",
    };
  },
};

export const CONNECTORS: Record<Destination, DestinationConnector> = {
  tally: tallyConnector,
  excel: excelConnector,
  google_sheets: sheetConnector,
};

export function connectorFor(destination: Destination): DestinationConnector {
  return CONNECTORS[destination];
}
