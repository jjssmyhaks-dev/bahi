import type {
  Destination,
  DocType,
  PermissionLevel,
  RuleResult,
  TenantSettings,
} from "@/lib/types";
import { summarizeRules } from "./rules";

export interface RouteInput {
  destination: Destination;
  overallConfidence: number;
  rules: RuleResult[];
  amountMinor: number;
  settings: TenantSettings;
  autonomyMode: "draft" | "autonomous";
  autonomyStage?: number;
  shadowMode?: boolean;
  killSwitch: boolean;
  postedToday: number;
  docType?: DocType;
  vendorKnown?: boolean;
  learnedLedger?: boolean;
  /** The permission level read when the run started. Falls back to autonomy mode. */
  permissionLevel?: PermissionLevel | undefined;
  /** Overrides the tenant's hard ceiling amount for this decision. */
  ceilingMinor?: number | undefined;
  /** Spreadsheet column mapping confirmed once. Undefined means not evaluated. */
  mappingConfirmed?: boolean | undefined;
  /** Destination reachable and authorised. Undefined means not evaluated. */
  destinationHealthy?: boolean | undefined;
  /** Blurred, cropped, handwritten or unsure classification. */
  documentQuality?: "good" | "suspect" | undefined;
}

export interface RouteDecision {
  action: "auto_post" | "review";
  reasons: string[];
  priority: number;
  /** True when the engine would post but is only recording the decision. */
  shadow: boolean;
  wouldPost: boolean;
}

/**
 * The confidence router. Failures always go to review. Auto-posting needs the
 * tenant in autonomous mode, no kill switch, the stage's evidence (repeat vendor
 * for stage 2), a clear threshold, no blocking warnings and room under the cap.
 *
 * The permission level changes the gate. Ask every time always shows a card.
 * Auto approve applies the thresholds and risk conditions below. Full access
 * skips the confidence, warning, stage and shadow checks, but never the hard
 * stops: failed rules, duplicates, the kill switch, the daily cap or the
 * owner-set ceiling amount.
 *
 * Stage 0 posts nothing, stage 1 records shadow decisions, stage 2 auto-posts
 * only repeat vendors below a low cap, stage 3 widens to all validated records,
 * and stage 4 posts everything that clears rules and confidence.
 */
export function routeRecord(input: RouteInput): RouteDecision {
  const { failed, warned } = summarizeRules(input.rules);
  const threshold =
    input.settings.docThresholds[input.docType ?? "supplier_invoice"] ??
    input.settings.thresholds[input.destination];
  const stage = Math.max(0, Math.min(4, input.autonomyStage ?? input.settings.autonomy.stage));
  const shadowMode = stage === 1 ? true : (input.shadowMode ?? input.settings.autonomy.shadowMode);
  const level: PermissionLevel =
    input.permissionLevel ?? (input.autonomyMode === "draft" ? "ask" : "auto");
  const ceilingMinor = Math.max(0, input.ceilingMinor ?? input.settings.permissions.ceilingMinor);
  const reasons: string[] = [];
  let priority = 100;

  if (failed.length) {
    reasons.push(...failed.map((rule) => rule.message));
    priority = 10;
  }

  if (input.killSwitch) {
    reasons.push("The owner's kill switch is on, so every record waits for a person.");
    priority = Math.min(priority, 20);
  }

  if (ceilingMinor > 0 && input.amountMinor > ceilingMinor) {
    reasons.push(
      "The value is above the workspace ceiling, which always needs a person whatever the permission level.",
    );
    priority = Math.min(priority, 25);
  }

  if (input.postedToday >= input.settings.limits.dailyPostCap) {
    reasons.push("The daily auto-post cap has been reached.");
    priority = Math.min(priority, 30);
  }

  if (level === "ask") {
    reasons.push("Ask every time is on, so this record waits for a person before writing.");
    priority = Math.min(priority, 60);
  }

  if (level === "full") {
    const wouldPost = reasons.length === 0;
    return wouldPost
      ? { action: "auto_post", reasons: [], priority, shadow: false, wouldPost: true }
      : { action: "review", reasons, priority, shadow: false, wouldPost: false };
  }

  if (input.overallConfidence < threshold.minConfidence) {
    reasons.push(
      `Overall confidence ${(input.overallConfidence * 100).toFixed(0)}% is below the ${(
        threshold.minConfidence * 100
      ).toFixed(
        0,
      )}% threshold for ${input.destination === "tally" ? "Tally" : "spreadsheet"} writes.`,
    );
    priority = Math.min(priority, 30);
  }

  if (warned.length && !threshold.allowWarnings) {
    reasons.push(...warned.map((rule) => rule.message));
    priority = Math.min(priority, 40);
  }

  const cap =
    input.settings.limits.docValueMinor[input.docType ?? "supplier_invoice"] ??
    input.settings.limits.autoPostValueMinor;
  if (input.amountMinor > cap) {
    reasons.push("The value is above the auto-post limit for this document type.");
    priority = Math.min(priority, 60);
  }

  if (input.mappingConfirmed === false) {
    reasons.push(
      "This destination has no confirmed column mapping yet, so the first write needs a person.",
    );
    priority = Math.min(priority, 50);
  }

  if (input.destinationHealthy === false) {
    reasons.push("The destination is not reachable or not authorised right now.");
    priority = Math.min(priority, 50);
  }

  if (input.documentQuality === "suspect") {
    reasons.push("The document is hard to read or the classifier was unsure of its type.");
    priority = Math.min(priority, 50);
  }

  if (stage === 0) {
    reasons.push("Foundations stage: the engine records checks but never posts on its own.");
    priority = Math.min(priority, 70);
  } else if (stage === 2) {
    const lowRiskCap = Math.min(cap, Math.round(input.settings.limits.autoPostValueMinor * 0.2));
    if (input.amountMinor > lowRiskCap) {
      reasons.push("Stage 2 only auto-posts low-value records below the low-risk cap.");
      priority = Math.min(priority, 60);
    }
    if (!input.vendorKnown) {
      reasons.push("Stage 2 needs a supplier with a confirmed master record.");
      priority = Math.min(priority, 60);
    }
    if (!input.learnedLedger) {
      reasons.push("Stage 2 needs a learned ledger mapping for this supplier.");
      priority = Math.min(priority, 60);
    }
  } else if (stage === 3) {
    if (input.docType === "bank_statement" && input.overallConfidence < 0.9) {
      reasons.push("Bank statement lines need at least 90% confidence at stage 3.");
      priority = Math.min(priority, 50);
    }
  }

  if (input.amountMinor >= 10_000_000) priority = Math.max(1, priority - 10);

  const wouldPost = reasons.length === 0;
  if (shadowMode && wouldPost) {
    return {
      action: "review",
      reasons: [
        `Shadow decision: this record would have been posted to ${input.destination}. Nothing was written.`,
      ],
      priority: Math.min(priority, 70),
      shadow: true,
      wouldPost: true,
    };
  }
  if (!wouldPost) {
    return { action: "review", reasons, priority, shadow: false, wouldPost: false };
  }
  return { action: "auto_post", reasons: [], priority, shadow: false, wouldPost: true };
}
