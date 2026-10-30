import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  Check,
  ChevronDown,
  Lock,
  ShieldAlert,
  ShieldCheck,
  ShieldQuestion,
  type LucideIcon,
} from "lucide-react";
import { toast } from "sonner";

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { updateSettingsFn } from "@/lib/api";
import {
  FULL_ACCESS_CONFIRMATION,
  PERMISSION_DESCRIPTIONS,
  PERMISSION_LABELS,
  PERMISSION_LEVELS,
} from "@/lib/permissions";
import type { PermissionLevel } from "@/lib/types";

const ICONS: Record<PermissionLevel, LucideIcon> = {
  ask: ShieldQuestion,
  auto: ShieldCheck,
  full: ShieldAlert,
};

export function PermissionPicker({
  level,
  canChange,
  align = "start",
  className,
}: {
  level: PermissionLevel;
  canChange: boolean;
  align?: "start" | "center" | "end";
  className?: string;
}) {
  const queryClient = useQueryClient();
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [phrase, setPhrase] = useState("");
  const [saving, setSaving] = useState(false);

  const Icon = ICONS[level];
  const full = level === "full";

  async function apply(next: PermissionLevel) {
    setSaving(true);
    try {
      await updateSettingsFn({ data: { permissions: { level: next } } });
      await queryClient.invalidateQueries({ queryKey: ["workspace"] });
      await queryClient.invalidateQueries({ queryKey: ["settings"] });
      toast.success(`Permission level is now ${PERMISSION_LABELS[next]}.`);
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "The permission level could not be changed.",
      );
    } finally {
      setSaving(false);
    }
  }

  function choose(next: PermissionLevel) {
    if (!canChange || next === level || saving) return;
    if (next === "full") {
      setPhrase("");
      setConfirmOpen(true);
      return;
    }
    void apply(next);
  }

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            disabled={!canChange}
            title={
              canChange
                ? `${PERMISSION_LABELS[level]} — ${PERMISSION_DESCRIPTIONS[level]}`
                : "Only the workspace owner can change the permission level."
            }
            className={`inline-flex h-8 items-center gap-1.5 rounded-full border px-3 text-xs transition-colors disabled:cursor-not-allowed disabled:opacity-70 ${
              full
                ? "border-destructive/40 bg-destructive/10 text-destructive"
                : "border-border bg-background text-muted-foreground hover:bg-muted hover:text-foreground"
            } ${className ?? ""}`}
          >
            {canChange ? <Icon className="h-3.5 w-3.5" /> : <Lock className="h-3.5 w-3.5" />}
            {PERMISSION_LABELS[level]}
            {canChange ? <ChevronDown className="h-3 w-3 opacity-60" /> : null}
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align={align} className="w-72">
          <DropdownMenuLabel className="text-[11px] font-medium text-muted-foreground">
            What may I do without asking?
          </DropdownMenuLabel>
          {PERMISSION_LEVELS.map((option) => {
            const OptionIcon = ICONS[option];
            const active = option === level;
            const danger = option === "full";
            return (
              <DropdownMenuItem
                key={option}
                onSelect={() => choose(option)}
                className="items-start gap-2.5 py-2.5"
              >
                <OptionIcon
                  className={`mt-0.5 h-4 w-4 shrink-0 ${
                    danger
                      ? "text-destructive"
                      : active
                        ? "text-foreground"
                        : "text-muted-foreground"
                  }`}
                />
                <span className="min-w-0 flex-1">
                  <span
                    className={`flex items-center gap-1.5 text-xs font-semibold ${
                      danger ? "text-destructive" : ""
                    }`}
                  >
                    {PERMISSION_LABELS[option]}
                    {active ? <Check className="h-3 w-3" /> : null}
                  </span>
                  <span className="mt-0.5 block text-[11px] leading-relaxed text-muted-foreground">
                    {PERMISSION_DESCRIPTIONS[option]}
                  </span>
                </span>
              </DropdownMenuItem>
            );
          })}
        </DropdownMenuContent>
      </DropdownMenu>

      <Dialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <DialogContent className="max-w-md border-destructive/30">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-destructive">
              <ShieldAlert className="h-5 w-5" />
              Turn on Full access?
            </DialogTitle>
            <DialogDescription className="space-y-2 text-sm leading-relaxed">
              <span className="block">
                Full access means Bahi never asks before writing. Anything it reads from a supplier
                bill, a statement or a chat message can be entered into your ledger without a person
                looking at it.
              </span>
              <span className="block font-medium text-foreground">
                The hard stops stay on: failed validation, duplicates, the kill switch, the daily
                cap and your ceiling amount still block a write.
              </span>
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <label htmlFor="full-access-phrase" className="text-xs text-muted-foreground">
              Type{" "}
              <span className="font-mono font-semibold text-foreground">
                {FULL_ACCESS_CONFIRMATION}
              </span>{" "}
              to confirm.
            </label>
            <Input
              id="full-access-phrase"
              value={phrase}
              onChange={(event) => setPhrase(event.target.value)}
              autoComplete="off"
              className="font-mono text-sm"
              placeholder={FULL_ACCESS_CONFIRMATION}
            />
          </div>
          <DialogFooter className="gap-2 sm:gap-0">
            <button
              type="button"
              onClick={() => setConfirmOpen(false)}
              className="btn-outline h-9 px-4 text-xs"
            >
              Keep asking
            </button>
            <button
              type="button"
              disabled={phrase.trim().toUpperCase() !== FULL_ACCESS_CONFIRMATION || saving}
              onClick={async () => {
                await apply("full");
                setConfirmOpen(false);
              }}
              className="inline-flex h-9 items-center justify-center rounded-full bg-destructive px-4 text-xs font-semibold text-destructive-foreground transition-opacity hover:opacity-90 disabled:opacity-50"
            >
              {saving ? "Saving…" : "Turn on Full access"}
            </button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
