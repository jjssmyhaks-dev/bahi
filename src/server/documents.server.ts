import { createHash, randomBytes } from "node:crypto";

import type { DocumentRow, SessionUser } from "@/lib/types";
import { saveEmbedding } from "./agents/store.server";
import { hashEmbedding } from "./agents/embedding";
import { adminClient } from "./auth.server";
import { sql, sqlOne, table } from "./db.server";
import { mapDocument } from "./repo.server";
import { transcribeImages, transcribePdf, visionEnabled } from "./vision.server";

const MAX_BYTES = 10 * 1024 * 1024;
const SUPPORTED_IMAGES = /^image\//;

export interface IncomingFile {
  name: string;
  mimeType: string;
  base64: string;
}

export interface StoredDocument {
  document: DocumentRow;
  text: string;
  pageCount: number | null;
  error: string | null;
  duplicateOf: string | null;
}

function safeName(name: string): string {
  return name.replace(/[^A-Za-z0-9._-]+/g, "_").slice(0, 80) || "document";
}

function fmtDate(value: Date): string {
  return `${String(value.getDate()).padStart(2, "0")}/${String(value.getMonth() + 1).padStart(2, "0")}/${value.getFullYear()}`;
}

export interface ExtractedFile {
  text: string;
  pageCount: number | null;
  error: string | null;
  renderMode: "text" | "vision" | "spreadsheet" | null;
}

const NO_VISION =
  "This PDF has no readable text layer. It looks like a scan or a photo, and the vision model is not configured here. Upload a text-based PDF or paste the invoice details.";

async function extractPdf(buffer: Buffer): Promise<ExtractedFile> {
  let text = "";
  let pageCount: number | null = null;
  try {
    const { extractText, getDocumentProxy } = await import("unpdf");
    const pdf = await getDocumentProxy(new Uint8Array(buffer));
    // Keep page boundaries so the classifier can split bundles.
    const result = await extractText(pdf, { mergePages: false });
    const pages = Array.isArray(result.text) ? result.text : [result.text];
    text = pages.join("\f").trim();
    pageCount = result.totalPages ?? pages.length;
  } catch {
    return {
      text: "",
      pageCount: null,
      error: "The PDF could not be opened. It may be corrupted or password protected.",
      renderMode: null,
    };
  }

  if (text.length >= 30) return { text, pageCount, error: null, renderMode: "text" };
  if (!visionEnabled()) return { text, pageCount, error: NO_VISION, renderMode: null };

  try {
    const vision = await transcribePdf(buffer);
    const cleaned = vision.text.trim();
    if (cleaned.replace(/\s+/g, "").length < 20) {
      return {
        text: cleaned,
        pageCount: pageCount ?? vision.pages,
        error:
          "This PDF is a scan and the vision model could not make out enough text. Try a sharper photo or upload the original digital PDF.",
        renderMode: null,
      };
    }
    return {
      text: cleaned,
      pageCount: pageCount ?? vision.pages,
      error: null,
      renderMode: "vision",
    };
  } catch {
    return {
      text,
      pageCount,
      error:
        "This PDF is a scan and the vision model could not read it right now. Try again later or upload the original digital PDF.",
      renderMode: null,
    };
  }
}

async function extractSpreadsheet(buffer: Buffer): Promise<{ text: string; error: string | null }> {
  try {
    const ExcelJS = (await import("exceljs")).default;
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(buffer as unknown as ArrayBuffer);
    const sheet = workbook.worksheets[0];
    if (!sheet) return { text: "", error: "The workbook has no sheets." };
    const lines: string[] = [];
    sheet.eachRow({ includeEmpty: false }, (row) => {
      const values = (row.values as unknown[]).slice(1).map((cell) => {
        if (cell instanceof Date) return fmtDate(cell);
        if (cell && typeof cell === "object" && "text" in cell)
          return String((cell as { text: unknown }).text);
        if (cell && typeof cell === "object" && "result" in cell)
          return String((cell as { result: unknown }).result);
        return cell === null || cell === undefined ? "" : String(cell);
      });
      if (values.some((value) => value !== "")) lines.push(values.join(" | "));
    });
    let text = lines.join("\n");
    if (/debit|withdrawal/i.test(text) && /credit|deposit/i.test(text)) {
      text = `Statement of Account\nAccount: Uploaded workbook\n\n${text}`;
    }
    return { text, error: null };
  } catch {
    return {
      text: "",
      error:
        "The Excel workbook could not be read. Save it as .xlsx or export a CSV and try again.",
    };
  }
}

export async function extractFileText(
  buffer: Buffer,
  mimeType: string,
  filename: string,
): Promise<ExtractedFile> {
  const extension = filename.toLowerCase().split(".").pop() ?? "";

  if (mimeType === "application/pdf" || extension === "pdf") return extractPdf(buffer);

  if (
    mimeType.includes("spreadsheetml") ||
    mimeType.includes("ms-excel") ||
    extension === "xlsx" ||
    extension === "xls"
  ) {
    const result = await extractSpreadsheet(buffer);
    return { ...result, pageCount: 1, renderMode: "spreadsheet" };
  }

  if (
    mimeType.startsWith("text/") ||
    ["csv", "tsv", "txt", "json"].includes(extension) ||
    mimeType === "application/json"
  ) {
    return {
      text: buffer.toString("utf8").split("\u0000").join("").trim(),
      pageCount: 1,
      error: null,
      renderMode: "text",
    };
  }

  if (SUPPORTED_IMAGES.test(mimeType)) {
    if (!visionEnabled()) {
      return {
        text: "",
        pageCount: 1,
        error:
          "This is an image or a phone photo. Reading photos needs the vision model, which is not configured here. Upload a text-based PDF or paste the invoice details.",
        renderMode: null,
      };
    }
    try {
      const vision = await transcribeImages([{ buffer, mimeType }]);
      const cleaned = vision.text.trim();
      if (cleaned.replace(/\s+/g, "").length < 10) {
        return {
          text: cleaned,
          pageCount: 1,
          error:
            "The vision model could not make out enough text in this photo. Try a sharper, well-lit photo or upload a digital PDF.",
          renderMode: null,
        };
      }
      return { text: cleaned, pageCount: 1, error: null, renderMode: "vision" };
    } catch {
      return {
        text: "",
        pageCount: 1,
        error:
          "The vision model could not read this photo right now. Try again later or upload a digital PDF.",
        renderMode: null,
      };
    }
  }

  if (extension === "docx" || mimeType.includes("wordprocessingml") || extension === "doc") {
    return {
      text: "",
      pageCount: 1,
      error: "Word documents are not supported yet. Export to PDF or paste the details as text.",
      renderMode: null,
    };
  }

  return {
    text: "",
    pageCount: 1,
    error: `I can't read ${extension ? "." + extension : "that file type"} yet. Send a PDF, image, spreadsheet, CSV or pasted text.`,
    renderMode: null,
  };
}

interface ContentDuplicate {
  id: string;
  filename: string;
  similarity: number;
}

/**
 * Compares the document text against earlier uploads in the same workspace.
 * A near-identical scan of the same invoice should not become a second entry,
 * even when the file hash differs.
 */
async function findContentDuplicate(
  schema: string,
  documentId: string,
  text: string,
  contentHash: string,
): Promise<ContentDuplicate | null> {
  const clean = text.replace(/\s+/g, " ").trim().slice(0, 8_000);
  if (clean.length < 200) return null;
  const vector = hashEmbedding(clean);
  const embedding = JSON.stringify(vector);
  try {
    await saveEmbedding(schema, {
      subjectType: "document",
      subjectId: documentId,
      contentHash,
      embedding: vector,
      model: "bahi-hash-256",
    });
  } catch {
    return null;
  }
  const rows = await sql<{ id: string; filename: string; similarity: number }>(
    `select e.subject_id as id, d.filename,
            1 - (e.embedding <=> $1::vector) as similarity
       from ${table(schema, "embeddings")} e
       join ${table(schema, "documents")} d on d.id = e.subject_id
      where e.subject_type = 'document'
        and e.subject_id <> $2
        and e.content_hash <> $3
        and d.status <> 'failed'
      order by e.embedding <=> $1::vector
      limit 1`,
    [embedding, documentId, contentHash],
  );
  const match = rows[0];
  if (!match || Number(match.similarity) < 0.99) return null;
  return { id: match.id, filename: match.filename, similarity: Number(match.similarity) };
}

export async function storeDocument(
  session: SessionUser,
  chatId: string,
  file: IncomingFile,
  sourceChannel: DocumentRow["sourceChannel"] = "chat",
): Promise<StoredDocument> {
  const base64 = file.base64.includes(",")
    ? file.base64.slice(file.base64.indexOf(",") + 1)
    : file.base64;
  const buffer = Buffer.from(base64, "base64");
  const filename = safeName(file.name || "document");
  const mimeType = file.mimeType || "application/octet-stream";
  const sha256 = createHash("sha256").update(buffer).digest("hex");

  const duplicate = await sqlOne<{ id: string; filename: string; created_at: Date }>(
    `select id, filename, created_at from ${table(session.schema, "documents")}
      where sha256 = $1 and status <> 'failed' order by created_at asc limit 1`,
    [sha256],
  );

  if (buffer.length > MAX_BYTES) {
    return storeFailed(
      session,
      chatId,
      filename,
      mimeType,
      buffer.length,
      sha256,
      "This file is larger than 10 MB. Split it or upload a smaller copy.",
    );
  }

  const inserted = await sqlOne<Record<string, unknown>>(
    `insert into ${table(session.schema, "documents")}
      (chat_id, user_id, filename, mime_type, size_bytes, sha256, status, source_channel, permission_level)
     values ($1, $2, $3, $4, $5, $6, 'processing', $7, $8) returning *`,
    [
      chatId,
      session.userId,
      filename,
      mimeType,
      buffer.length,
      sha256,
      sourceChannel,
      session.permissionLevel,
    ],
  );
  if (!inserted) throw new Error("Could not record the upload.");
  const documentId = String(inserted["id"]);

  if (duplicate) {
    const error = `This file was already uploaded as ${duplicate.filename} on ${new Date(
      duplicate.created_at,
    ).toLocaleDateString("en-IN")}. I've kept one copy to avoid duplicate entries.`;
    await sql(
      `update ${table(session.schema, "documents")} set status = 'needs_attention', error = $2 where id = $1`,
      [documentId, error],
    );
    const document = mapDocument({ ...inserted, status: "needs_attention", error })!;
    return { document, text: "", pageCount: null, error, duplicateOf: duplicate.id };
  }

  let storagePath: string | null = `bahi/${session.tenantId}/${documentId}/${filename}`;
  try {
    const { error } = await adminClient()
      .storage.from("documents")
      .upload(storagePath, buffer, { contentType: mimeType, upsert: false });
    if (error) storagePath = null;
  } catch {
    storagePath = null;
  }

  const extracted = await extractFileText(buffer, mimeType, filename);
  const contentDuplicate = extracted.text
    ? await findContentDuplicate(session.schema, documentId, extracted.text, sha256).catch(
        () => null,
      )
    : null;
  const error = contentDuplicate
    ? `This looks like the same document as ${contentDuplicate.filename} (${Math.round(
        contentDuplicate.similarity * 100,
      )}% text match). I've kept one copy to avoid a duplicate entry.`
    : extracted.error;
  const status = error ? "needs_attention" : "extracted";
  await sql(
    `update ${table(session.schema, "documents")}
        set storage_path = $2, status = $3, error = $4, page_count = $5, extracted_text = $6,
            render_mode = $7
      where id = $1`,
    [
      documentId,
      storagePath,
      status,
      error,
      extracted.pageCount,
      extracted.text || null,
      extracted.renderMode,
    ],
  );

  const document = mapDocument({
    ...inserted,
    storage_path: storagePath,
    status,
    error,
    page_count: extracted.pageCount,
    extracted_text: extracted.text,
    render_mode: extracted.renderMode,
  })!;

  return {
    document,
    text: extracted.text,
    pageCount: extracted.pageCount,
    error,
    duplicateOf: contentDuplicate?.id ?? null,
  };
}

async function storeFailed(
  session: SessionUser,
  chatId: string,
  filename: string,
  mimeType: string,
  size: number,
  sha256: string,
  error: string,
): Promise<StoredDocument> {
  const inserted = await sqlOne<Record<string, unknown>>(
    `insert into ${table(session.schema, "documents")}
      (chat_id, user_id, filename, mime_type, size_bytes, sha256, status, error)
     values ($1, $2, $3, $4, $5, $6, 'needs_attention', $7) returning *`,
    [chatId, session.userId, filename, mimeType, size, sha256, error],
  );
  if (!inserted) throw new Error("Could not record the upload.");
  return { document: mapDocument(inserted)!, text: "", pageCount: null, error, duplicateOf: null };
}

export async function createTypedDocument(
  session: SessionUser,
  chatId: string,
  text: string,
): Promise<StoredDocument> {
  const buffer = Buffer.from(text, "utf8");
  const sha256 = createHash("sha256").update(buffer).digest("hex");
  const inserted = await sqlOne<Record<string, unknown>>(
    `insert into ${table(session.schema, "documents")}
      (chat_id, user_id, filename, mime_type, size_bytes, sha256, status, extracted_text, render_mode)
     values ($1, $2, $3, 'text/plain', $4, $5, 'extracted', $6, 'typed') returning *`,
    [
      chatId,
      session.userId,
      `typed-note-${randomBytes(2).toString("hex")}.txt`,
      buffer.length,
      sha256,
      text,
    ],
  );
  if (!inserted) throw new Error("Could not add the note.");
  return { document: mapDocument(inserted)!, text, pageCount: 1, error: null, duplicateOf: null };
}

export async function createSampleDocument(
  session: SessionUser,
  chatId: string,
  sample: {
    filename: string;
    mimeType: string;
    expectedType: DocumentRow["docType"];
    text: string;
  },
): Promise<DocumentRow> {
  const buffer = Buffer.from(sample.text, "utf8");
  const sha256 = createHash("sha256").update(buffer).digest("hex");
  const inserted = await sqlOne<Record<string, unknown>>(
    `insert into ${table(session.schema, "documents")}
      (chat_id, user_id, filename, mime_type, size_bytes, sha256, status, doc_type, page_count, extracted_text, render_mode, permission_level)
     values ($1, $2, $3, $4, $5, $6, 'extracted', $7, 1, $8, 'text', $9) returning *`,
    [
      chatId,
      session.userId,
      sample.filename,
      sample.mimeType,
      buffer.length,
      sha256,
      sample.expectedType,
      sample.text,
      session.permissionLevel,
    ],
  );
  if (!inserted) throw new Error("Could not add the sample document.");
  return mapDocument(inserted)!;
}

export async function getDocumentUrl(
  session: SessionUser,
  documentId: string,
): Promise<string | null> {
  const row = await sqlOne<{ storage_path: string | null }>(
    `select storage_path from ${table(session.schema, "documents")} where id = $1`,
    [documentId],
  );
  if (!row?.storage_path) return null;
  const { data, error } = await adminClient()
    .storage.from("documents")
    .createSignedUrl(row.storage_path, 3600);
  if (error) return null;
  return data.signedUrl;
}
