import { STATUS_LABELS } from "@/lib/format";
import type { Destination, RecordStatus } from "@/lib/types";

const STATUS_TONE: Record<RecordStatus, string> = {
  pending_review: "bg-chip text-chip-foreground",
  approved: "bg-secondary text-secondary-foreground",
  posted: "bg-foreground text-background",
  written: "bg-foreground text-background",
  rejected: "bg-destructive/10 text-destructive",
  held: "bg-secondary text-muted-foreground",
  failed: "bg-destructive/10 text-destructive",
};

export function StatusBadge({ status }: { status: RecordStatus }) {
  return (
    <span
      className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-[11px] font-semibold ${STATUS_TONE[status]}`}
    >
      {STATUS_LABELS[status]}
    </span>
  );
}

const DESTINATION_TONE: Record<Destination, string> = {
  tally: "border-border bg-card text-foreground",
  excel: "border-border bg-card text-foreground",
  google_sheets: "border-border bg-card text-foreground",
};

export function DestinationBadge({ destination }: { destination: Destination }) {
  const label =
    destination === "tally" ? "TallyPrime" : destination === "excel" ? "Excel" : "Google Sheets";
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-[11px] font-medium ${DESTINATION_TONE[destination]}`}
    >
      <span className="h-1.5 w-1.5 rounded-full bg-foreground/50" />
      {label}
    </span>
  );
}
