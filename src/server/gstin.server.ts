import { env } from "./env.server";
import { isValidGstin } from "./rules";

export interface GstinLookup {
  gstin: string;
  formatValid: boolean;
  verified: boolean;
  status?: "active" | "cancelled" | "suspended" | "unknown";
  legalName?: string;
  tradeName?: string;
  state?: string;
  message: string;
}

export type GstinResult = { ok: true; data: GstinLookup } | { ok: false; message: string };

export function gstinConfigured(): boolean {
  return Boolean(env.gstn.url);
}

function gstinUrl(value: string): string {
  const configured = env.gstn.url;
  if (configured.includes("{gstin}")) {
    return configured.replace(/\{gstin\}/g, encodeURIComponent(value));
  }
  return `${configured}${configured.includes("?") ? "&" : "?"}gstin=${encodeURIComponent(value)}`;
}

function gstinStatus(value: unknown): NonNullable<GstinLookup["status"]> {
  const text = String(value ?? "")
    .trim()
    .toLowerCase();
  if (!text) return "unknown";
  if (text.includes("cancel")) return "cancelled";
  if (text.includes("suspend")) return "suspended";
  if (["active", "act", "1", "valid", "enabled"].includes(text)) return "active";
  return "unknown";
}

/** Calls the configured GSTN provider; without one, only local format checks run. */
export async function verifyGstin(gstin: string): Promise<GstinResult> {
  const value = gstin.replace(/\s+/g, "").toUpperCase();
  if (!isValidGstin(value)) {
    return {
      ok: true,
      data: {
        gstin: value,
        formatValid: false,
        verified: false,
        message: "The GSTIN is not correctly formed, so GSTN was not called.",
      },
    };
  }
  if (!gstinConfigured()) {
    return {
      ok: true,
      data: {
        gstin: value,
        formatValid: true,
        verified: false,
        status: "unknown",
        message:
          "No GSTN provider is configured. Only the 15-character format and checksum were checked.",
      },
    };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8_000);
  try {
    const response = await fetch(gstinUrl(value), {
      headers: {
        accept: "application/json",
        ...(env.gstn.apiKey
          ? { "x-api-key": env.gstn.apiKey, authorization: `Bearer ${env.gstn.apiKey}` }
          : {}),
      },
      signal: controller.signal,
    });
    if (!response.ok) {
      return { ok: false, message: `The GSTN provider returned HTTP ${response.status}.` };
    }
    const raw = (await response.json()) as Record<string, unknown>;
    const body = (raw.data ?? raw.result ?? raw) as Record<string, unknown>;
    const status = gstinStatus(
      body.status ?? body.sts ?? body.gstin_status ?? body.gstStatus ?? body.registrationStatus,
    );
    const legalName = String(body.legal_name ?? body.lgnm ?? body.legalName ?? "").trim();
    const tradeName = String(body.trade_name ?? body.tradeNam ?? body.tradeName ?? "").trim();
    const state = String(body.state ?? body.state_name ?? body.pradr_state ?? "").trim();
    return {
      ok: true,
      data: {
        gstin: value,
        formatValid: true,
        verified: true,
        status,
        ...(legalName ? { legalName } : {}),
        ...(tradeName ? { tradeName } : {}),
        ...(state ? { state } : {}),
        message:
          status === "active"
            ? `GSTN shows ${tradeName || legalName || value} as active.`
            : `GSTN shows the registration as ${status}.`,
      },
    };
  } catch (error) {
    return {
      ok: false,
      message:
        error instanceof Error && error.name === "AbortError"
          ? "The GSTN provider did not answer within 8 seconds."
          : "The GSTN provider could not be reached.",
    };
  } finally {
    clearTimeout(timer);
  }
}
