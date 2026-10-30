import { z } from "zod";

import { classifyDocument } from "../extraction";
import { PROMPT_VERSIONS, classifierPrompt } from "./prompts";
import { runAgent, type AgentDefinition } from "./runner.server";
import type {
  AgentOutput,
  ClassifiedSegment,
  ClassifierResult,
  RunContext,
  SegmentDescriptor,
  SegmentDocType,
} from "./types";

const SEGMENT_TYPES = [
  "supplier_invoice",
  "credit_note",
  "purchase_order",
  "goods_receipt",
  "e_way_bill",
  "e_invoice",
  "bank_statement",
  "unknown",
] as const;

const qualitySchema = z.object({
  blurred: z.boolean().optional(),
  rotated: z.boolean().optional(),
  cropped: z.boolean().optional(),
  note: z.string().max(300).optional(),
});

const segmentSchema = z.object({
  pageStart: z.number().int().min(1).nullable(),
  pageEnd: z.number().int().min(1).nullable(),
  docType: z.enum(SEGMENT_TYPES),
  confidence: z.number().min(0).max(1),
  quality: qualitySchema.default({}),
});

export const classifierSchema = z.object({
  segments: z.array(segmentSchema).min(1).max(50),
});

const DOCUMENT_HEADER =
  /tax\s+invoice|statement of account|bank statement|purchase order|delivery challan|goods receipt|receipt note|e-?way bill|e-?invoice/i;

export function splitPages(text: string): string[] {
  const normalised = text.split("\u0000").join("");
  if (!normalised.trim()) return [""];
  const pages = normalised.split("\f");
  return pages.length ? pages : [""];
}

function textForSegment(pages: string[], segment: SegmentDescriptor): string {
  const start = Math.max(1, segment.pageStart ?? 1);
  const end = Math.max(start, segment.pageEnd ?? start);
  return pages
    .slice(start - 1, end)
    .join("\n")
    .trim();
}

export function deterministicSegments(pages: string[]): SegmentDescriptor[] {
  const segments: SegmentDescriptor[] = [];
  let previousType: SegmentDocType | null = null;

  pages.forEach((page, index) => {
    const printed = page.trim();
    const detected = classifyDocument(printed);
    const hasHeader = DOCUMENT_HEADER.test(printed);
    let docType: SegmentDocType = detected ?? "unknown";
    let confidence = detected ? 0.96 : 0.2;
    const quality: SegmentDescriptor["quality"] = {};

    if (!detected && printed.length < 40) {
      quality.note = "Very little readable text on this page.";
      confidence = 0.1;
    } else if (!detected && previousType && previousType !== "unknown" && printed.length >= 40) {
      docType = previousType;
      confidence = 0.55;
      quality.note = "Continued page without its own document header.";
    } else if (!detected) {
      quality.note = "Not recognised as a business document.";
    }

    const last = segments.at(-1);
    const startsNewDocument = !last || last.docType !== docType || hasHeader;

    if (startsNewDocument) {
      segments.push({
        pageStart: index + 1,
        pageEnd: index + 1,
        docType,
        confidence,
        quality,
      });
    } else if (last) {
      last.pageEnd = index + 1;
      last.confidence = Math.min(last.confidence, confidence);
      if (quality.note) last.quality = { ...last.quality, ...quality };
    }

    if (detected) previousType = detected;
    else if (!last || last.docType !== "unknown") previousType = docType;
  });

  return segments.length
    ? segments
    : [
        {
          pageStart: 1,
          pageEnd: null,
          docType: "unknown",
          confidence: 0,
          quality: { note: "The file had no readable text." },
        },
      ];
}

function fallback(input: { filename: string; text: string }): AgentOutput<ClassifierResult> {
  const pages = splitPages(input.text);
  const descriptors = deterministicSegments(pages);
  const unknown = descriptors.filter((segment) => segment.docType === "unknown");
  const confidence =
    descriptors.reduce((sum, segment) => sum + segment.confidence, 0) / descriptors.length;
  return {
    result: { segments: descriptors },
    envelope: {
      confidence,
      warnings: unknown.map(
        (segment) =>
          `Page ${segment.pageStart ?? "?"} does not look like a supplier document and needs a person.`,
      ),
      reason: `Deterministic classification found ${descriptors.length} segment${
        descriptors.length === 1 ? "" : "s"
      } in ${pages.length} page${pages.length === 1 ? "" : "s"}.`,
    },
  };
}

export const classifierAgent: AgentDefinition<
  { filename: string; text: string },
  ClassifierResult
> = {
  id: "document_classifier",
  promptVersion: PROMPT_VERSIONS.document_classifier,
  schema: classifierSchema,
  fallback,
  buildPrompt: (input, context) => classifierPrompt(context, input),
};

export interface ClassifiedDocument {
  output: AgentOutput<ClassifierResult>;
  segments: ClassifiedSegment[];
  pages: string[];
}

export async function runClassifier(
  context: RunContext,
  input: { filename: string; text: string },
): Promise<ClassifiedDocument> {
  const pages = splitPages(input.text);
  const output = await runAgent(classifierAgent, input, context);
  const segments: ClassifiedSegment[] = output.result.segments.map((segment, index) => ({
    ...segment,
    index,
    text: textForSegment(pages, segment),
  }));
  return { output, segments, pages };
}
