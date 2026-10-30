import type { PermissionLevel } from "./types";

export const PERMISSION_LEVELS: PermissionLevel[] = ["ask", "auto", "full"];

export const PERMISSION_LABELS: Record<PermissionLevel, string> = {
  ask: "Ask every time",
  auto: "Auto approve",
  full: "Full access",
};

export const PERMISSION_SHORT_LABELS: Record<PermissionLevel, string> = {
  ask: "Ask",
  auto: "Auto",
  full: "Full",
};

export const PERMISSION_DESCRIPTIONS: Record<PermissionLevel, string> = {
  ask: "Always ask before writing anything to your files or accounts.",
  auto: "Only asks when a potential risk is detected.",
  full: "Never ask. The platform writes everything straight to your destinations.",
};

/** The owner has to type this before Full access is switched on. */
export const FULL_ACCESS_CONFIRMATION = "FULL ACCESS";

export function isPermissionLevel(value: unknown): value is PermissionLevel {
  return value === "ask" || value === "auto" || value === "full";
}

export function permissionLabel(level: PermissionLevel | null | undefined): string {
  return level ? PERMISSION_LABELS[level] : "Auto approve";
}
