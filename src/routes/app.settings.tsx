import { useEffect, useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Copy,
  FileSpreadsheet,
  Loader2,
  RefreshCw,
  ShieldCheck,
  Trash2,
  Upload,
} from "lucide-react";
import { toast } from "sonner";

import { PageHeader } from "@/components/app/page-header";
import { PermissionPicker } from "@/components/app/permission-picker";
import { DESTINATION_LABELS, formatINR } from "@/lib/format";
import { PERMISSION_DESCRIPTIONS, PERMISSION_LABELS, PERMISSION_LEVELS } from "@/lib/permissions";
import type { Destination, TenantSettings } from "@/lib/types";
import {
  bridgeFn,
  changeRoleFn,
  chooseSpreadsheetFn,
  clearPackOverrideFn,
  createBridgeAgentFn,
  createIntakeSourceFn,
  deleteIntakeSourceFn,
  importGstr2bFn,
  inviteMemberFn,
  platformFn,
  purgeRetentionFn,
  reconnectSheetFn,
  removeMemberFn,
  revokeBridgeAgentFn,
  revokeInviteFn,
  rollbackPackFn,
  savePackOverrideFn,
  setIntakeSourceStatusFn,
  setPackFn,
  settingsFn,
  updateSettingsFn,
  uploadExcelTemplateFn,
} from "@/lib/api";

type SettingsData = Awaited<ReturnType<typeof settingsFn>>;
type Thresholds = TenantSettings["thresholds"];

export const Route = createFileRoute("/app/settings")({
  head: () => ({ meta: [{ title: "Settings — Bahi" }] }),
  component: SettingsPage,
});

const inputClass =
  "h-10 w-full rounded-xl border border-border bg-background px-3 text-sm outline-none transition-colors focus:border-foreground/30 focus:ring-2 focus:ring-foreground/10 disabled:opacity-60";

const STAGES: { value: number; label: string; detail: string }[] = [
  {
    value: 0,
    label: "0 · Read only",
    detail: "Documents are read and checked, but nothing is written anywhere.",
  },
  {
    value: 1,
    label: "1 · Draft for review",
    detail: "Every record waits in the queue for a person to approve it.",
  },
  {
    value: 2,
    label: "2 · Write with approval",
    detail: "Approved records are written to the destination straight away.",
  },
  {
    value: 3,
    label: "3 · Auto-write high confidence",
    detail: "Records above your confidence and value limits post without review.",
  },
  {
    value: 4,
    label: "4 · Fully autonomous",
    detail: "Only failed checks and low confidence wait for a person.",
  },
];

function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ""));
    reader.onerror = () => reject(new Error("The file could not be read."));
    reader.readAsDataURL(file);
  });
}

function SettingsPage() {
  const queryClient = useQueryClient();
  const settings = useQuery({ queryKey: ["settings"], queryFn: () => settingsFn() });
  const platform = useQuery({ queryKey: ["platform"], queryFn: () => platformFn() });

  const [kill, setKill] = useState(false);
  const [ceilingRupees, setCeilingRupees] = useState(0);
  const [defaultDestination, setDefaultDestination] = useState<Destination>("tally");
  const [thresholds, setThresholds] = useState<Thresholds | null>(null);
  const [autoPostRupees, setAutoPostRupees] = useState(50000);
  const [dailyCap, setDailyCap] = useState(100);
  const [stage, setStage] = useState(0);
  const [shadow, setShadow] = useState(false);
  const [errorBudget, setErrorBudget] = useState(5);
  const [autoAssign, setAutoAssign] = useState(true);
  const [dueDays, setDueDays] = useState(3);
  const [saving, setSaving] = useState(false);
  const [reconnecting, setReconnecting] = useState(false);
  const bridge = useQuery({ queryKey: ["bridge"], queryFn: () => bridgeFn() });
  const [agentLabel, setAgentLabel] = useState("Tally PC");
  const [agentCompany, setAgentCompany] = useState("");
  const [agentToken, setAgentToken] = useState<string | null>(null);
  const [creatingAgent, setCreatingAgent] = useState(false);
  const [sheetLink, setSheetLink] = useState("");
  const [sheetTab, setSheetTab] = useState("");
  const [connectingSheet, setConnectingSheet] = useState(false);
  const [uploadingTemplate, setUploadingTemplate] = useState(false);
  const [importingGstr2b, setImportingGstr2b] = useState(false);
  const [gstrPeriod, setGstrPeriod] = useState("");
  const [retentionDays, setRetentionDays] = useState(365);
  const [purging, setPurging] = useState(false);
  const [overrideText, setOverrideText] = useState("");
  const [packBusy, setPackBusy] = useState(false);
  const [inviteEmail, setInviteEmail] = useState("");
  const [inviteRole, setInviteRole] = useState<"owner" | "reviewer" | "viewer">("reviewer");
  const [inviteLink, setInviteLink] = useState<string | null>(null);
  const [inviting, setInviting] = useState(false);
  const [intakeChannel, setIntakeChannel] = useState<"email" | "whatsapp">("email");
  const [intakeAddress, setIntakeAddress] = useState("");
  const [intakeSecret, setIntakeSecret] = useState<string | null>(null);
  const [creatingIntake, setCreatingIntake] = useState(false);

  const data = settings.data;
  const isOwner = data?.role === "owner";

  useEffect(() => {
    if (!data) return;
    setKill(data.killSwitch);
    setCeilingRupees(Math.round(data.settings.permissions.ceilingMinor / 100));
    setDefaultDestination(data.settings.defaultDestination);
    setThresholds(data.settings.thresholds);
    setAutoPostRupees(Math.round(data.settings.limits.autoPostValueMinor / 100));
    setDailyCap(data.settings.limits.dailyPostCap);
    setStage(data.autonomy.stage);
    setShadow(data.autonomy.shadowMode);
    setErrorBudget(data.autonomy.errorBudgetPct);
    setAutoAssign(data.settings.review.autoAssign);
    setDueDays(data.settings.review.dueDays);
    setRetentionDays(data.settings.retentionDays);
    // Seed the form whenever the server settings change, not on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data?.settings, data?.autonomyMode, data?.killSwitch, data?.autonomy]);

  useEffect(() => {
    const override = platform.data?.packs.override;
    setOverrideText(override ? JSON.stringify(override.patch, null, 2) : "");
    // Reseed only when the saved override changes; the object identity is new on
    // every fetch and would wipe edits in progress.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [platform.data?.packs.override?.id]);

  function updateThreshold(destination: Destination, patch: Partial<Thresholds[Destination]>) {
    setThresholds((current) =>
      current
        ? {
            ...current,
            [destination]: { ...current[destination], ...patch },
          }
        : current,
    );
  }

  async function save() {
    if (!thresholds) return;
    setSaving(true);
    try {
      await updateSettingsFn({
        data: {
          killSwitch: kill,
          defaultDestination,
          permissions: { ceilingMinor: Math.round(Math.max(0, ceilingRupees) * 100) },
          thresholds: {
            tally: thresholds.tally,
            excel: thresholds.excel,
            google_sheets: thresholds.google_sheets,
          },
          limits: {
            autoPostValueMinor: Math.round(autoPostRupees * 100),
            dailyPostCap: dailyCap,
          },
          autonomy: { stage, shadowMode: shadow, errorBudgetPct: errorBudget },
          review: { autoAssign, dueDays },
          retentionDays,
        },
      });
      toast.success("Settings saved.");
      await queryClient.invalidateQueries();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not save the settings.");
    } finally {
      setSaving(false);
    }
  }

  async function reconnect() {
    setReconnecting(true);
    try {
      await reconnectSheetFn();
      toast.success("Google Sheets connection refreshed.");
      await queryClient.invalidateQueries();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not reconnect the sheet.");
    } finally {
      setReconnecting(false);
    }
  }

  async function connectSheet() {
    setConnectingSheet(true);
    try {
      const summary = await chooseSpreadsheetFn({
        data: {
          spreadsheet: sheetLink,
          ...(sheetTab.trim() ? { sheetName: sheetTab.trim() } : {}),
        },
      });
      toast.success(`Writing to ${summary.title} · ${summary.sheetName}.`);
      setSheetLink("");
      setSheetTab("");
      await queryClient.invalidateQueries();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not use that spreadsheet.");
    } finally {
      setConnectingSheet(false);
    }
  }

  async function uploadTemplate(file: File) {
    if (!file.name.toLowerCase().endsWith(".xlsx")) {
      toast.error("Save the template as .xlsx and upload that.");
      return;
    }
    if (file.size > 10 * 1024 * 1024) {
      toast.error("The template is larger than 10 MB.");
      return;
    }
    setUploadingTemplate(true);
    try {
      const base64 = await fileToBase64(file);
      const template = await uploadExcelTemplateFn({ data: { name: file.name, base64 } });
      const recognised = template.columns.filter((column) => column.field).length;
      toast.success(
        `Using ${template.filename} — ${recognised} of ${template.columns.length} columns recognised.`,
      );
      await queryClient.invalidateQueries({ queryKey: ["settings"] });
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not read the template.");
    } finally {
      setUploadingTemplate(false);
    }
  }

  async function importGstr(file: File) {
    setImportingGstr2b(true);
    try {
      const content = await file.text();
      const summary = await importGstr2bFn({
        data: {
          name: file.name,
          content,
          ...(gstrPeriod ? { period: gstrPeriod } : {}),
        },
      });
      toast.success(
        `${summary.period}: ${summary.matched} matched, ${summary.mismatched} different, ${summary.missingInBooks} missing from your books.`,
      );
      await queryClient.invalidateQueries();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not import the GSTR-2B file.");
    } finally {
      setImportingGstr2b(false);
    }
  }

  async function choosePack(key: string, version: string) {
    setPackBusy(true);
    try {
      await setPackFn({ data: { key, version } });
      toast.success(`Using ${key} v${version}.`);
      await queryClient.invalidateQueries();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not switch the pack.");
    } finally {
      setPackBusy(false);
    }
  }

  async function rollback() {
    setPackBusy(true);
    try {
      await rollbackPackFn();
      toast.success("Rolled back to the previous pack version.");
      await queryClient.invalidateQueries();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not roll back the pack.");
    } finally {
      setPackBusy(false);
    }
  }

  async function saveOverride() {
    const pack = platform.data?.packs.active;
    if (!pack) return;
    let patch: Record<string, unknown>;
    try {
      const parsed = JSON.parse(overrideText || "{}");
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new Error("The override must be a JSON object.");
      }
      patch = parsed as Record<string, unknown>;
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "That is not valid JSON.");
      return;
    }
    setPackBusy(true);
    try {
      await savePackOverrideFn({ data: { packKey: pack.key, patch } });
      toast.success("Pack override saved.");
      await queryClient.invalidateQueries();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not save the override.");
    } finally {
      setPackBusy(false);
    }
  }

  async function clearOverride() {
    const pack = platform.data?.packs.active;
    if (!pack) return;
    setPackBusy(true);
    try {
      await clearPackOverrideFn({ data: { packKey: pack.key } });
      toast.success("Override cleared.");
      setOverrideText("");
      await queryClient.invalidateQueries();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not clear the override.");
    } finally {
      setPackBusy(false);
    }
  }

  async function sendInvite() {
    setInviting(true);
    try {
      const result = await inviteMemberFn({
        data: { email: inviteEmail.trim(), role: inviteRole },
      });
      setInviteLink(
        result.link.startsWith("http") ? result.link : `${window.location.origin}${result.link}`,
      );
      setInviteEmail("");
      toast.success("Invite created. Copy the link and send it to them.");
      await queryClient.invalidateQueries({ queryKey: ["platform"] });
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not create the invite.");
    } finally {
      setInviting(false);
    }
  }

  async function revokeInvite(id: string) {
    try {
      await revokeInviteFn({ data: { inviteId: id } });
      setInviteLink(null);
      await queryClient.invalidateQueries({ queryKey: ["platform"] });
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not revoke the invite.");
    }
  }

  async function changeRole(userId: string, role: "owner" | "reviewer" | "viewer") {
    try {
      await changeRoleFn({ data: { userId, role } });
      toast.success("Role updated.");
      await queryClient.invalidateQueries();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not change the role.");
    }
  }

  async function removePerson(userId: string) {
    if (!window.confirm("Remove this person from the workspace?")) return;
    try {
      await removeMemberFn({ data: { userId } });
      toast.success("Removed from the workspace.");
      await queryClient.invalidateQueries();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not remove them.");
    }
  }

  async function createSource() {
    setCreatingIntake(true);
    try {
      const result = await createIntakeSourceFn({
        data: { channel: intakeChannel, address: intakeAddress.trim() },
      });
      setIntakeSecret(result.secret);
      setIntakeAddress("");
      toast.success("Intake address created. Copy its secret now — it is shown once.");
      await queryClient.invalidateQueries({ queryKey: ["platform"] });
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not create the intake address.");
    } finally {
      setCreatingIntake(false);
    }
  }

  async function toggleSource(sourceId: string, status: "active" | "paused") {
    try {
      await setIntakeSourceStatusFn({ data: { sourceId, status } });
      await queryClient.invalidateQueries({ queryKey: ["platform"] });
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not update the address.");
    }
  }

  async function removeSource(sourceId: string) {
    if (!window.confirm("Remove this intake address? Documents already received are kept.")) return;
    try {
      await deleteIntakeSourceFn({ data: { sourceId } });
      setIntakeSecret(null);
      await queryClient.invalidateQueries({ queryKey: ["platform"] });
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not remove the address.");
    }
  }

  async function purgeNow() {
    if (
      !window.confirm(
        `Delete stored documents older than ${retentionDays} days? Ledger records are kept.`,
      )
    ) {
      return;
    }
    setPurging(true);
    try {
      const result = await purgeRetentionFn();
      toast.success(
        `Deleted ${result.deleted} stored document${result.deleted === 1 ? "" : "s"} older than ${result.retentionDays} days.`,
      );
      await queryClient.invalidateQueries();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not purge documents.");
    } finally {
      setPurging(false);
    }
  }

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const result = params.get("google");
    if (!result) return;
    if (result === "connected") toast.success("Google account connected.");
    else if (result.startsWith("error:")) toast.error(result.slice(6));
    params.delete("google");
    const next = `${window.location.pathname}${params.toString() ? `?${params}` : ""}`;
    window.history.replaceState({}, "", next);
    void queryClient.invalidateQueries();
  }, [queryClient]);

  async function addAgent() {
    setCreatingAgent(true);
    try {
      const created = await createBridgeAgentFn({
        data: { label: agentLabel, companyName: agentCompany },
      });
      setAgentToken(created.token);
      setAgentCompany("");
      toast.success("Bridge agent created. Copy its token now — it is shown once.");
      await bridge.refetch();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not create the agent.");
    } finally {
      setCreatingAgent(false);
    }
  }

  async function revokeAgent(agentId: string) {
    try {
      await revokeBridgeAgentFn({ data: { agentId } });
      toast.success("Agent revoked. Its queued commands were expired.");
      await bridge.refetch();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not revoke the agent.");
    }
  }

  if (settings.isLoading || !thresholds) {
    return (
      <div className="flex justify-center py-20">
        <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="Settings"
        title="Autonomy, limits and connections"
        description="These rules decide which records post themselves and which wait for a person. Only the workspace owner can change them."
        actions={
          <button
            type="button"
            onClick={save}
            disabled={!isOwner || saving}
            className="btn-primary h-9 px-4 text-xs"
          >
            {saving ? "Saving…" : "Save changes"}
          </button>
        }
      />

      {!isOwner ? (
        <p className="rounded-2xl border border-border bg-card px-4 py-3 text-xs text-muted-foreground">
          You are signed in as a {data?.role ?? "member"}. These settings are read-only for your
          role.
        </p>
      ) : null}

      <section className="rounded-2xl border border-border bg-card p-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <p className="text-sm font-semibold">Permission level</p>
            <p className="mt-1 max-w-xl text-xs text-muted-foreground">
              How much Bahi may do without asking. The level applies to every document run and is
              recorded on each record it touches.
            </p>
          </div>
          <PermissionPicker
            level={data?.settings.permissions.level ?? "auto"}
            canChange={Boolean(isOwner)}
            align="end"
          />
        </div>

        <div className="mt-4 grid gap-2 sm:grid-cols-3">
          {PERMISSION_LEVELS.map((option) => {
            const current = data?.settings.permissions.level === option;
            const danger = option === "full";
            return (
              <div
                key={option}
                className={`rounded-xl border p-3 ${
                  current
                    ? danger
                      ? "border-destructive/40 bg-destructive/5"
                      : "border-foreground/25 bg-muted/60"
                    : "border-border bg-background"
                }`}
              >
                <p
                  className={`text-xs font-semibold ${danger ? "text-destructive" : "text-foreground"}`}
                >
                  {PERMISSION_LABELS[option]}
                </p>
                <p className="mt-1 text-[11px] leading-relaxed text-muted-foreground">
                  {PERMISSION_DESCRIPTIONS[option]}
                </p>
              </div>
            );
          })}
        </div>

        <div className="mt-5 flex flex-wrap items-center justify-between gap-3 border-t border-border pt-4">
          <div>
            <p className="text-sm font-semibold">Always-ask ceiling</p>
            <p className="mt-1 max-w-xl text-xs text-muted-foreground">
              Any record above this amount always waits for a person, whatever the permission level.
              Leave it at 0 to switch the ceiling off.
            </p>
          </div>
          <label className="flex items-center gap-2 text-xs">
            <span className="text-muted-foreground">₹</span>
            <input
              type="number"
              min={0}
              step={1000}
              value={ceilingRupees}
              disabled={!isOwner}
              onChange={(event) => setCeilingRupees(Math.max(0, Number(event.target.value) || 0))}
              className="h-9 w-36 rounded-full border border-border bg-background px-3 text-right text-xs outline-none disabled:opacity-60"
            />
            <span className="text-[11px] text-muted-foreground">
              {ceilingRupees > 0 ? formatINR(Math.round(ceilingRupees * 100)) : "Off"}
            </span>
          </label>
        </div>

        <div className="mt-5 flex flex-wrap items-center justify-between gap-3 border-t border-border pt-4">
          <div>
            <p className="text-sm font-semibold">Kill switch</p>
            <p className="mt-1 max-w-xl text-xs text-muted-foreground">
              Stops every automatic write immediately. Records keep arriving in the queue, but
              nothing is entered until it is switched off.
            </p>
          </div>
          <button
            type="button"
            disabled={!isOwner}
            onClick={() => setKill((value) => !value)}
            className={`inline-flex h-9 items-center gap-2 rounded-full px-4 text-xs font-medium transition-colors disabled:opacity-60 ${
              kill
                ? "bg-destructive text-destructive-foreground"
                : "border border-border bg-background text-foreground"
            }`}
          >
            <span
              className={`h-2 w-2 rounded-full ${kill ? "bg-destructive-foreground" : "bg-foreground/40"}`}
            />
            {kill ? "Paused — click to resume" : "Running"}
          </button>
        </div>
      </section>

      <section className="rounded-2xl border border-border bg-card p-5">
        <p className="text-sm font-semibold">Confidence thresholds</p>
        <p className="mt-1 text-xs text-muted-foreground">
          A record needs at least this overall confidence to post without review. Warnings can be
          allowed per destination.
        </p>
        <div className="mt-4 space-y-4">
          {(Object.keys(DESTINATION_LABELS) as Destination[]).map((destination) => {
            const entry = thresholds[destination];
            const percent = Math.round(entry.minConfidence * 100);
            return (
              <div key={destination} className="rounded-xl border border-border bg-background p-4">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <p className="text-xs font-semibold">{DESTINATION_LABELS[destination]}</p>
                  <span className="text-xs font-medium text-muted-foreground">
                    {percent}% confidence
                  </span>
                </div>
                <input
                  type="range"
                  min={50}
                  max={100}
                  step={1}
                  value={percent}
                  disabled={!isOwner}
                  onChange={(event) =>
                    updateThreshold(destination, {
                      minConfidence: Number(event.target.value) / 100,
                    })
                  }
                  className="mt-3 w-full accent-foreground disabled:opacity-60"
                />
                <label className="mt-3 flex items-center gap-2 text-xs text-muted-foreground">
                  <input
                    type="checkbox"
                    checked={entry.allowWarnings}
                    disabled={!isOwner}
                    onChange={(event) =>
                      updateThreshold(destination, { allowWarnings: event.target.checked })
                    }
                    className="h-3.5 w-3.5 accent-foreground"
                  />
                  Allow warning-only records to post automatically
                </label>
              </div>
            );
          })}
        </div>
      </section>

      <section className="rounded-2xl border border-border bg-card p-5">
        <p className="text-sm font-semibold">Value and volume limits</p>
        <div className="mt-4 grid gap-4 sm:grid-cols-2">
          <label className="block">
            <span className="text-xs font-medium text-muted-foreground">Auto-post value limit</span>
            <input
              type="number"
              min={0}
              value={autoPostRupees}
              disabled={!isOwner}
              onChange={(event) => setAutoPostRupees(Number(event.target.value))}
              className={`${inputClass} mt-1`}
            />
            <span className="mt-1.5 block text-[11px] text-muted-foreground">
              Anything above {formatINR(autoPostRupees * 100)} always goes to review.
            </span>
          </label>
          <label className="block">
            <span className="text-xs font-medium text-muted-foreground">Daily auto-post cap</span>
            <input
              type="number"
              min={1}
              max={500}
              value={dailyCap}
              disabled={!isOwner}
              onChange={(event) => setDailyCap(Number(event.target.value))}
              className={`${inputClass} mt-1`}
            />
            <span className="mt-1.5 block text-[11px] text-muted-foreground">
              After this many automatic posts in a day, the rest wait for review.
            </span>
          </label>
          <label className="block">
            <span className="text-xs font-medium text-muted-foreground">Default destination</span>
            <select
              value={defaultDestination}
              disabled={!isOwner}
              onChange={(event) => setDefaultDestination(event.target.value as Destination)}
              className={`${inputClass} mt-1`}
            >
              {(Object.keys(DESTINATION_LABELS) as Destination[]).map((destination) => (
                <option key={destination} value={destination}>
                  {DESTINATION_LABELS[destination]}
                </option>
              ))}
            </select>
          </label>
        </div>

        <div className="mt-5 flex flex-wrap items-end justify-between gap-3 border-t border-border pt-4">
          <label className="block">
            <span className="text-xs font-medium text-muted-foreground">
              Keep stored documents for
            </span>
            <div className="mt-1 flex items-center gap-2">
              <input
                type="number"
                min={30}
                max={3650}
                value={retentionDays}
                disabled={!isOwner}
                onChange={(event) => setRetentionDays(Number(event.target.value))}
                className={`${inputClass} w-28`}
              />
              <span className="text-xs text-muted-foreground">days</span>
            </div>
            <span className="mt-1.5 block text-[11px] text-muted-foreground">
              After this, files and their text are deleted. Ledger records stay.
            </span>
          </label>
          <button
            type="button"
            onClick={purgeNow}
            disabled={!isOwner || purging}
            className="btn-outline h-9 px-4 text-xs"
          >
            {purging ? "Purging…" : "Purge old documents now"}
          </button>
        </div>
      </section>

      <section className="rounded-2xl border border-border bg-card p-5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <p className="text-sm font-semibold">Plan pack</p>
            <p className="mt-1 max-w-xl text-xs text-muted-foreground">
              The pack decides which documents, rules and mappings this workspace uses. You can move
              to a newer published version and roll back if something changes.
            </p>
          </div>
          <span className="rounded-full bg-muted px-3 py-1 text-[11px] font-medium text-muted-foreground">
            {platform.data?.packs.active
              ? `${platform.data.packs.active.key} v${platform.data.packs.active.version}`
              : "No pack"}
          </span>
        </div>

        <div className="mt-4 flex flex-wrap items-center gap-2">
          <select
            value={
              platform.data?.packs.active
                ? `${platform.data.packs.active.key}|${platform.data.packs.active.version}`
                : ""
            }
            disabled={!isOwner || packBusy}
            onChange={(event) => {
              const [key, version] = event.target.value.split("|");
              if (key && version) void choosePack(key, version);
            }}
            className={`${inputClass} h-9 w-auto min-w-64`}
          >
            {(platform.data?.packs.packs ?? []).map((pack) => (
              <option key={`${pack.key}|${pack.version}`} value={`${pack.key}|${pack.version}`}>
                {pack.name} · v{pack.version}
              </option>
            ))}
          </select>
          <button
            type="button"
            onClick={rollback}
            disabled={!isOwner || packBusy}
            className="btn-outline h-9 px-4 text-xs"
          >
            {packBusy ? "Working…" : "Roll back a version"}
          </button>
        </div>

        <div className="mt-4 rounded-xl border border-border bg-background p-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-xs font-medium">Custom overrides</p>
            {platform.data?.packs.override ? (
              <span className="text-[11px] text-muted-foreground">
                Saved {new Date(platform.data.packs.override.createdAt).toLocaleString()}
              </span>
            ) : (
              <span className="text-[11px] text-muted-foreground">None</span>
            )}
          </div>
          <p className="mt-1 text-[11px] text-muted-foreground">
            A JSON object merged over the pack's config for this workspace only.
          </p>
          <textarea
            value={overrideText}
            disabled={!isOwner}
            onChange={(event) => setOverrideText(event.target.value)}
            placeholder={'{\n  "rulesVersion": "2026-05"\n}'}
            rows={6}
            className="mt-3 w-full rounded-xl border border-border bg-background px-3 py-2 font-mono text-xs outline-none transition-colors focus:border-foreground/30 focus:ring-2 focus:ring-foreground/10 disabled:opacity-60"
          />
          <div className="mt-2 flex flex-wrap gap-2">
            <button
              type="button"
              onClick={saveOverride}
              disabled={!isOwner || packBusy}
              className="btn-primary h-8 px-3 text-xs"
            >
              Save override
            </button>
            <button
              type="button"
              onClick={clearOverride}
              disabled={!isOwner || packBusy || !platform.data?.packs.override}
              className="btn-outline h-8 px-3 text-xs"
            >
              Clear
            </button>
          </div>
        </div>

        {platform.data ? (
          <details className="mt-3 rounded-xl border border-border bg-background px-3 py-2">
            <summary className="cursor-pointer text-[11px] font-medium text-muted-foreground">
              Effective config
            </summary>
            <pre className="mt-2 max-h-56 overflow-auto text-[11px] text-muted-foreground">
              {JSON.stringify(platform.data.packs.effectiveConfig, null, 2)}
            </pre>
          </details>
        ) : null}
      </section>

      <section className="rounded-2xl border border-border bg-card p-5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <p className="text-sm font-semibold">Team</p>
            <p className="mt-1 max-w-xl text-xs text-muted-foreground">
              Owners change settings, reviewers work the queue, viewers can only read. Everyone
              shares the same workspace and records.
            </p>
          </div>
          <span className="rounded-full bg-muted px-3 py-1 text-[11px] font-medium text-muted-foreground">
            {platform.data?.team.length ?? 0} member
            {(platform.data?.team.length ?? 0) === 1 ? "" : "s"}
          </span>
        </div>

        <ul className="mt-4 divide-y divide-border rounded-xl border border-border">
          {(platform.data?.team ?? []).map((member) => (
            <li
              key={member.id}
              className="flex flex-wrap items-center justify-between gap-2 px-3 py-2.5"
            >
              <div className="min-w-0">
                <p className="truncate text-xs font-medium">
                  {member.name}
                  {member.id === data?.userId ? " · you" : ""}
                </p>
                <p className="truncate text-[11px] text-muted-foreground">{member.email}</p>
              </div>
              <div className="flex items-center gap-2">
                <select
                  value={member.role}
                  disabled={!isOwner || member.id === data?.userId}
                  onChange={(event) =>
                    void changeRole(
                      member.id,
                      event.target.value as "owner" | "reviewer" | "viewer",
                    )
                  }
                  className="h-8 rounded-full border border-border bg-background px-2 text-[11px] capitalize outline-none disabled:opacity-60"
                >
                  <option value="owner">Owner</option>
                  <option value="reviewer">Reviewer</option>
                  <option value="viewer">Viewer</option>
                </select>
                {isOwner && member.id !== data?.userId ? (
                  <button
                    type="button"
                    onClick={() => void removePerson(member.id)}
                    className="rounded-full p-1.5 text-muted-foreground hover:bg-muted hover:text-destructive"
                    aria-label={`Remove ${member.name}`}
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                ) : null}
              </div>
            </li>
          ))}
        </ul>

        {isOwner ? (
          <div className="mt-4 grid gap-3 rounded-xl border border-border bg-background p-4 sm:grid-cols-[1.6fr_1fr_auto]">
            <input
              type="email"
              value={inviteEmail}
              onChange={(event) => setInviteEmail(event.target.value)}
              placeholder="teammate@company.com"
              className={inputClass}
            />
            <select
              value={inviteRole}
              onChange={(event) =>
                setInviteRole(event.target.value as "owner" | "reviewer" | "viewer")
              }
              className={inputClass}
            >
              <option value="reviewer">Reviewer</option>
              <option value="viewer">Viewer</option>
              <option value="owner">Owner</option>
            </select>
            <button
              type="button"
              onClick={sendInvite}
              disabled={inviting || !inviteEmail.trim()}
              className="btn-primary h-10 px-4 text-xs"
            >
              {inviting ? "Creating…" : "Create invite link"}
            </button>
          </div>
        ) : null}

        {inviteLink ? (
          <div className="mt-3 rounded-lg border border-amber-300/60 bg-amber-50 p-3">
            <p className="text-[11px] font-medium text-amber-900">
              Send this link to the person. It works once and expires in 7 days.
            </p>
            <div className="mt-2 flex items-center gap-2">
              <code className="min-w-0 flex-1 truncate rounded bg-background px-2 py-1 text-[11px]">
                {inviteLink}
              </code>
              <button
                type="button"
                onClick={() => {
                  void navigator.clipboard.writeText(inviteLink);
                  toast.success("Invite link copied.");
                }}
                className="btn-outline h-8 px-2 text-[11px]"
              >
                <Copy className="h-3 w-3" />
              </button>
            </div>
          </div>
        ) : null}

        {platform.data?.invites.length ? (
          <div className="mt-4">
            <p className="text-xs font-medium">Pending invites</p>
            <ul className="mt-2 divide-y divide-border rounded-xl border border-border">
              {platform.data.invites.map((invite) => (
                <li
                  key={invite.id}
                  className="flex flex-wrap items-center justify-between gap-2 px-3 py-2 text-[11px]"
                >
                  <span className="font-medium">{invite.email}</span>
                  <span className="capitalize text-muted-foreground">{invite.role}</span>
                  <span className="text-muted-foreground">
                    expires {new Date(invite.expiresAt).toLocaleDateString()}
                  </span>
                  {isOwner ? (
                    <button
                      type="button"
                      onClick={() => void revokeInvite(invite.id)}
                      className="text-muted-foreground hover:text-destructive"
                    >
                      Revoke
                    </button>
                  ) : null}
                </li>
              ))}
            </ul>
          </div>
        ) : null}
      </section>

      <section className="rounded-2xl border border-border bg-card p-5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <p className="text-sm font-semibold">Email and WhatsApp intake</p>
            <p className="mt-1 max-w-xl text-xs text-muted-foreground">
              Give an inbox or number its own secret, then forward documents to the webhook. Bahi
              reads each file exactly like a chat upload.
            </p>
          </div>
          <span className="rounded-full bg-muted px-3 py-1 text-[11px] font-medium text-muted-foreground">
            {platform.data?.intakeSources.length ?? 0} address
            {(platform.data?.intakeSources.length ?? 0) === 1 ? "" : "es"}
          </span>
        </div>

        {platform.data?.intakeSources.length ? (
          <ul className="mt-4 divide-y divide-border rounded-xl border border-border">
            {platform.data.intakeSources.map((source) => (
              <li
                key={source.id}
                className="flex flex-wrap items-center justify-between gap-2 px-3 py-2 text-[11px]"
              >
                <span className="font-medium">
                  <span className="capitalize">{source.channel}</span> · {source.address}
                </span>
                <span
                  className={`rounded-full px-2 py-0.5 font-medium ${
                    source.status === "active"
                      ? "bg-emerald-500/10 text-emerald-700"
                      : "bg-muted text-muted-foreground"
                  }`}
                >
                  {source.status}
                </span>
                {isOwner ? (
                  <span className="flex items-center gap-3">
                    <button
                      type="button"
                      onClick={() =>
                        void toggleSource(
                          source.id,
                          source.status === "active" ? "paused" : "active",
                        )
                      }
                      className="text-muted-foreground hover:text-foreground"
                    >
                      {source.status === "active" ? "Pause" : "Resume"}
                    </button>
                    <button
                      type="button"
                      onClick={() => void removeSource(source.id)}
                      className="text-muted-foreground hover:text-destructive"
                    >
                      Remove
                    </button>
                  </span>
                ) : null}
              </li>
            ))}
          </ul>
        ) : null}

        {isOwner ? (
          <div className="mt-4 grid gap-3 rounded-xl border border-border bg-background p-4 sm:grid-cols-[1fr_1.6fr_auto]">
            <select
              value={intakeChannel}
              onChange={(event) => setIntakeChannel(event.target.value as "email" | "whatsapp")}
              className={inputClass}
            >
              <option value="email">Email</option>
              <option value="whatsapp">WhatsApp</option>
            </select>
            <input
              value={intakeAddress}
              onChange={(event) => setIntakeAddress(event.target.value)}
              placeholder={intakeChannel === "email" ? "bills@company.com" : "+91 98765 43210"}
              className={inputClass}
            />
            <button
              type="button"
              onClick={createSource}
              disabled={creatingIntake || intakeAddress.trim().length < 3}
              className="btn-primary h-10 px-4 text-xs"
            >
              {creatingIntake ? "Creating…" : "Add address"}
            </button>
          </div>
        ) : null}

        {intakeSecret ? (
          <div className="mt-3 rounded-lg border border-amber-300/60 bg-amber-50 p-3">
            <p className="text-[11px] font-medium text-amber-900">
              Copy this secret into the forwarding rule now. It is not stored in plain text.
            </p>
            <code className="mt-2 block break-all rounded bg-background px-2 py-1 text-[11px]">
              {intakeSecret}
            </code>
            <p className="mt-2 text-[11px] text-amber-900">
              POST to <code>/api/intake/{intakeChannel}</code> with{" "}
              <code>{`{"address","secret","files":[{"name","mimeType","base64"}]}`}</code>
            </p>
          </div>
        ) : null}

        {platform.data?.intakeEvents.length ? (
          <div className="mt-4">
            <p className="text-xs font-medium">Recent intake</p>
            <ul className="mt-2 divide-y divide-border rounded-xl border border-border">
              {platform.data.intakeEvents.slice(0, 5).map((event) => (
                <li
                  key={event.id}
                  className="flex flex-wrap items-center justify-between gap-2 px-3 py-2 text-[11px]"
                >
                  <span className="font-medium capitalize">{event.channel}</span>
                  <span
                    className={`rounded-full px-2 py-0.5 font-medium ${
                      event.status === "processed"
                        ? "bg-emerald-500/10 text-emerald-700"
                        : event.status === "failed"
                          ? "bg-destructive/10 text-destructive"
                          : "bg-muted text-muted-foreground"
                    }`}
                  >
                    {event.status}
                  </span>
                  <span className="text-muted-foreground">
                    {String(event.detail["summary"] ?? event.detail["error"] ?? "")}
                  </span>
                  <span className="text-muted-foreground">
                    {new Date(event.createdAt).toLocaleString()}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        ) : null}
      </section>

      {platform.data?.jobs.length ? (
        <section className="rounded-2xl border border-border bg-card p-5">
          <p className="text-sm font-semibold">Background jobs</p>
          <p className="mt-1 text-xs text-muted-foreground">
            Retention sweeps, intake imports and daily summaries run through this queue.
          </p>
          <ul className="mt-3 divide-y divide-border rounded-xl border border-border">
            {platform.data.jobs.slice(0, 6).map((job) => (
              <li
                key={job.id}
                className="flex flex-wrap items-center justify-between gap-2 px-3 py-2 text-[11px]"
              >
                <span className="font-medium">{job.kind.replace(/\./g, " ")}</span>
                <span
                  className={`rounded-full px-2 py-0.5 font-medium ${
                    job.status === "done"
                      ? "bg-emerald-500/10 text-emerald-700"
                      : job.status === "failed"
                        ? "bg-destructive/10 text-destructive"
                        : "bg-muted text-muted-foreground"
                  }`}
                >
                  {job.status}
                </span>
                <span className="text-muted-foreground">
                  attempt {job.attempts}/{job.maxAttempts}
                </span>
                <span className="truncate text-muted-foreground">
                  {job.lastError ?? new Date(job.createdAt).toLocaleString()}
                </span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <section className="rounded-2xl border border-border bg-card p-5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <p className="text-sm font-semibold">Autonomy stage</p>
            <p className="mt-1 max-w-xl text-xs text-muted-foreground">
              How far Bahi is allowed to go on its own. The stage is separate from the permission
              level above; it is the gradual rollout the PRD describes.
            </p>
          </div>
          <span className="rounded-full bg-muted px-3 py-1 text-[11px] font-medium text-muted-foreground">
            {data?.autonomy.autoPosts ?? 0} auto · {data?.autonomy.errorRatePct ?? 0}% reversed
          </span>
        </div>

        <div className="mt-4 space-y-2">
          {STAGES.map((option) => (
            <label
              key={option.value}
              className={`flex cursor-pointer items-start gap-3 rounded-xl border px-3.5 py-3 transition-colors ${
                stage === option.value ? "border-foreground/30 bg-muted/50" : "border-border"
              } ${!isOwner ? "pointer-events-none opacity-60" : ""}`}
            >
              <input
                type="radio"
                name="autonomy-stage"
                checked={stage === option.value}
                disabled={!isOwner}
                onChange={() => setStage(option.value)}
                className="mt-0.5 h-3.5 w-3.5 accent-foreground"
              />
              <span>
                <span className="block text-xs font-medium">{option.label}</span>
                <span className="mt-0.5 block text-[11px] text-muted-foreground">
                  {option.detail}
                </span>
              </span>
            </label>
          ))}
        </div>

        <div className="mt-4 grid gap-4 border-t border-border pt-4 sm:grid-cols-2">
          <div>
            <label className="flex items-center gap-2 text-xs font-medium">
              <input
                type="checkbox"
                checked={shadow}
                disabled={!isOwner}
                onChange={(event) => setShadow(event.target.checked)}
                className="h-3.5 w-3.5 accent-foreground"
              />
              Shadow mode
            </label>
            <p className="mt-1.5 text-[11px] text-muted-foreground">
              Decisions are recorded and shown in Activity, but nothing is written to Tally or the
              sheet.
            </p>
          </div>
          <label className="block">
            <span className="text-xs font-medium text-muted-foreground">Error budget</span>
            <div className="mt-1 flex items-center gap-2">
              <input
                type="number"
                min={0}
                max={100}
                step={0.5}
                value={errorBudget}
                disabled={!isOwner}
                onChange={(event) => setErrorBudget(Number(event.target.value))}
                className={`${inputClass} w-24`}
              />
              <span className="text-xs text-muted-foreground">% of auto posts reversed</span>
            </div>
            <span className="mt-1.5 block text-[11px] text-muted-foreground">
              When reversals exceed this over 14 days, Bahi drops one stage by itself.
            </span>
          </label>
        </div>

        {data?.autonomy.events.length ? (
          <div className="mt-4 rounded-xl border border-border bg-background p-3">
            <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
              Recent stage changes
            </p>
            <ul className="mt-2 space-y-1.5">
              {data.autonomy.events.slice(0, 4).map((event) => (
                <li key={event.id} className="text-[11px] text-muted-foreground">
                  {new Date(event.createdAt).toLocaleString()} · Stage {event.stageFrom ?? "—"} →{" "}
                  {event.stageTo} · {event.reason}
                </li>
              ))}
            </ul>
          </div>
        ) : null}

        <div className="mt-5 border-t border-border pt-4">
          <p className="text-sm font-semibold">Review defaults</p>
          <div className="mt-3 grid gap-4 sm:grid-cols-2">
            <div>
              <label className="flex items-center gap-2 text-xs font-medium">
                <input
                  type="checkbox"
                  checked={autoAssign}
                  disabled={!isOwner}
                  onChange={(event) => setAutoAssign(event.target.checked)}
                  className="h-3.5 w-3.5 accent-foreground"
                />
                Assign new reviews automatically
              </label>
              <p className="mt-1.5 text-[11px] text-muted-foreground">
                Picks the owner or reviewer with the fewest open records.
              </p>
            </div>
            <label className="block">
              <span className="text-xs font-medium text-muted-foreground">Due after</span>
              <div className="mt-1 flex items-center gap-2">
                <input
                  type="number"
                  min={0}
                  max={90}
                  value={dueDays}
                  disabled={!isOwner}
                  onChange={(event) => setDueDays(Number(event.target.value))}
                  className={`${inputClass} w-24`}
                />
                <span className="text-xs text-muted-foreground">days (0 = no due date)</span>
              </div>
            </label>
          </div>
        </div>
      </section>

      <section className="rounded-2xl border border-border bg-card p-5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <p className="text-sm font-semibold">Tally bridge agent</p>
            <p className="mt-1 max-w-xl text-xs text-muted-foreground">
              The agent runs on the computer with TallyPrime, polls for commands and imports
              vouchers. Nothing is written to Tally until an agent acknowledges each voucher.
            </p>
          </div>
          <span
            className={`inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-[11px] font-medium ${
              bridge.data?.health.status === "connected"
                ? "bg-emerald-500/10 text-emerald-700"
                : "bg-muted text-muted-foreground"
            }`}
          >
            <span
              className={`h-1.5 w-1.5 rounded-full ${
                bridge.data?.health.status === "connected"
                  ? "bg-emerald-600"
                  : "bg-muted-foreground"
              }`}
            />
            {bridge.data?.health.status === "connected"
              ? "Connected"
              : bridge.data?.health.status === "offline"
                ? "Agent offline"
                : "Not connected"}
          </span>
        </div>
        {bridge.data ? (
          <p className="mt-2 text-[11px] text-muted-foreground">{bridge.data.health.detail}</p>
        ) : null}

        {bridge.data?.agents.length ? (
          <ul className="mt-4 space-y-2">
            {bridge.data.agents.map((agent) => (
              <li
                key={agent.id}
                className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-border bg-background px-3 py-2"
              >
                <div className="min-w-0">
                  <p className="text-xs font-medium">
                    {agent.label} · {agent.companyName}
                  </p>
                  <p className="text-[11px] text-muted-foreground">
                    {agent.status === "revoked"
                      ? "Revoked"
                      : agent.online
                        ? `Online · ${agent.version ?? "version unknown"}`
                        : agent.lastSeenAt
                          ? `Last seen ${new Date(agent.lastSeenAt).toLocaleString()}`
                          : "Never polled"}
                  </p>
                  {agent.lastError ? (
                    <p className="mt-0.5 truncate text-[11px] text-destructive">
                      {agent.lastError}
                    </p>
                  ) : null}
                </div>
                {isOwner && agent.status === "active" ? (
                  <button
                    type="button"
                    onClick={() => revokeAgent(agent.id)}
                    className="btn-outline h-8 px-3 text-[11px]"
                  >
                    <Trash2 className="h-3 w-3" />
                    Revoke
                  </button>
                ) : null}
              </li>
            ))}
          </ul>
        ) : null}

        {isOwner ? (
          <div className="mt-4 rounded-xl border border-border bg-background p-4">
            <p className="text-xs font-medium">Add an agent</p>
            <div className="mt-3 grid gap-3 sm:grid-cols-2">
              <input
                value={agentLabel}
                onChange={(event) => setAgentLabel(event.target.value)}
                placeholder="Agent name, e.g. Accounts PC"
                className={inputClass}
              />
              <input
                value={agentCompany}
                onChange={(event) => setAgentCompany(event.target.value)}
                placeholder="Exact Tally company name"
                className={inputClass}
              />
            </div>
            <button
              type="button"
              onClick={addAgent}
              disabled={creatingAgent || !agentLabel.trim() || !agentCompany.trim()}
              className="btn-primary mt-3 h-9 px-4 text-xs"
            >
              {creatingAgent ? "Creating…" : "Create agent token"}
            </button>
            {agentToken ? (
              <div className="mt-3 rounded-lg border border-amber-300/60 bg-amber-50 p-3">
                <p className="text-[11px] font-medium text-amber-900">
                  Copy this token into the agent's environment now. It is not stored and cannot be
                  shown again.
                </p>
                <div className="mt-2 flex items-center gap-2">
                  <code className="min-w-0 flex-1 truncate rounded bg-background px-2 py-1 text-[11px]">
                    {agentToken}
                  </code>
                  <button
                    type="button"
                    onClick={() => {
                      void navigator.clipboard.writeText(agentToken);
                      toast.success("Token copied.");
                    }}
                    className="btn-outline h-8 px-2 text-[11px]"
                  >
                    <Copy className="h-3 w-3" />
                  </button>
                </div>
                <p className="mt-2 text-[11px] text-amber-900">
                  Run: <code>BAHI_BASE_URL=… BAHI_BRIDGE_TOKEN=… node bridge/bahi-bridge.mjs</code>
                </p>
              </div>
            ) : null}
          </div>
        ) : null}

        {bridge.data?.commands.length ? (
          <div className="mt-4">
            <p className="text-xs font-medium">Recent commands</p>
            <ul className="mt-2 divide-y divide-border rounded-xl border border-border">
              {bridge.data.commands.slice(0, 8).map((command) => (
                <li
                  key={command.id}
                  className="flex items-center justify-between gap-3 px-3 py-2 text-[11px]"
                >
                  <span className="font-medium">{command.type.replace(/_/g, " ")}</span>
                  <span className="truncate text-muted-foreground">{command.idempotencyKey}</span>
                  <span
                    className={`rounded-full px-2 py-0.5 font-medium ${
                      command.status === "acked"
                        ? "bg-emerald-500/10 text-emerald-700"
                        : command.status === "failed"
                          ? "bg-destructive/10 text-destructive"
                          : "bg-muted text-muted-foreground"
                    }`}
                  >
                    {command.status}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        ) : null}

        <p className="mt-3 flex items-center gap-2 text-[11px] text-muted-foreground">
          <ShieldCheck className="h-3.5 w-3.5" />
          {bridge.data?.signed
            ? "Poll responses are signed; agents verify the signature before importing."
            : "Set BRIDGE_SIGNING_SECRET to sign poll responses. Without it, agents accept unsigned commands."}
        </p>
      </section>

      <section className="rounded-2xl border border-border bg-card p-5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <p className="text-sm font-semibold">Google Sheets connection</p>
            <p className="mt-1 text-xs text-muted-foreground">
              {data?.google.detail ?? "Sign in with Google to append rows."}
            </p>
            {data?.google.url ? (
              <a
                href={data.google.url}
                target="_blank"
                rel="noreferrer"
                className="mt-1 inline-block text-[11px] font-medium underline underline-offset-2"
              >
                Open spreadsheet
              </a>
            ) : null}
          </div>
          <span
            className={`rounded-full px-3 py-1 text-[11px] font-medium ${
              data?.google.status === "connected"
                ? "bg-emerald-500/10 text-emerald-700"
                : "bg-muted text-muted-foreground"
            }`}
          >
            {data?.google.status === "connected"
              ? "Connected"
              : data?.google.status === "not_configured"
                ? "OAuth not configured"
                : data?.google.status === "needs_spreadsheet"
                  ? "Choose a sheet"
                  : "Not connected"}
          </span>
        </div>

        <div className="mt-4 flex flex-wrap gap-2">
          <a
            href="/api/google/start"
            className={`btn-outline h-9 px-4 text-xs ${data?.google.status === "not_configured" ? "pointer-events-none opacity-50" : ""}`}
          >
            {data?.google.status === "not_configured"
              ? "Google OAuth unavailable"
              : data?.google.status === "needs_sign_in"
                ? "Sign in with Google"
                : "Re-authorize Google"}
          </a>
          <button
            type="button"
            onClick={reconnect}
            disabled={reconnecting || data?.google.status !== "connected"}
            className="btn-outline h-9 px-4 text-xs"
          >
            <RefreshCw className={`h-3.5 w-3.5 ${reconnecting ? "animate-spin" : ""}`} />
            Check token
          </button>
        </div>

        {data?.google.status === "needs_spreadsheet" || data?.google.status === "connected" ? (
          <div className="mt-4 rounded-xl border border-border bg-background p-4">
            <p className="text-xs font-medium">
              {data.google.status === "connected" ? "Change spreadsheet" : "Choose a spreadsheet"}
            </p>
            <div className="mt-3 grid gap-3 sm:grid-cols-[2fr_1fr]">
              <input
                value={sheetLink}
                onChange={(event) => setSheetLink(event.target.value)}
                placeholder="https://docs.google.com/spreadsheets/d/…"
                className={inputClass}
              />
              <input
                value={sheetTab}
                onChange={(event) => setSheetTab(event.target.value)}
                placeholder="Tab name (first tab by default)"
                className={inputClass}
              />
            </div>
            <button
              type="button"
              onClick={connectSheet}
              disabled={connectingSheet || !sheetLink.trim() || data?.role === "viewer"}
              className="btn-primary mt-3 h-9 px-4 text-xs"
            >
              {connectingSheet ? "Checking…" : "Use this spreadsheet"}
            </button>
            <p className="mt-2 text-[11px] text-muted-foreground">
              The Google account needs edit access to the spreadsheet. Bahi writes a header row
              once, then appends one row per record and remembers each row so it can undo a write.
            </p>
          </div>
        ) : null}

        <p className="mt-3 flex items-center gap-2 text-[11px] text-muted-foreground">
          <ShieldCheck className="h-3.5 w-3.5" />
          Refresh and access tokens are encrypted with AES-256-GCM before they are stored. Bahi
          never shows them again.
        </p>
      </section>

      <section className="rounded-2xl border border-border bg-card p-5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <p className="text-sm font-semibold">Excel template</p>
            <p className="mt-1 max-w-xl text-xs text-muted-foreground">
              Upload your accountant's workbook once. Excel exports then fill that same file, so its
              columns, formats and formulas are kept.
            </p>
          </div>
          <span
            className={`rounded-full px-3 py-1 text-[11px] font-medium ${
              data?.excelTemplate
                ? "bg-emerald-500/10 text-emerald-700"
                : "bg-muted text-muted-foreground"
            }`}
          >
            {data?.excelTemplate ? "Template active" : "Standard export"}
          </span>
        </div>

        {data?.excelTemplate ? (
          <div className="mt-4 rounded-xl border border-border bg-background p-4">
            <div className="flex items-center gap-2">
              <FileSpreadsheet className="h-4 w-4 text-muted-foreground" />
              <p className="min-w-0 flex-1 truncate text-xs font-medium">
                {data.excelTemplate.filename} · {data.excelTemplate.sheetName}
              </p>
            </div>
            <p className="mt-1 text-[11px] text-muted-foreground">
              Header on row {data.excelTemplate.headerRow} ·{" "}
              {data.excelTemplate.columns.filter((column) => column.field).length} of{" "}
              {data.excelTemplate.columns.length} columns recognised
            </p>
            {data.excelTemplate.columns.some((column) => !column.field) ? (
              <p className="mt-1 text-[11px] text-muted-foreground">
                Left as-is:{" "}
                {data.excelTemplate.columns
                  .filter((column) => !column.field)
                  .map((column) => column.header)
                  .join(", ")}
              </p>
            ) : null}
          </div>
        ) : null}

        <label
          className={`btn-outline mt-4 inline-flex h-9 cursor-pointer items-center gap-2 px-4 text-xs ${
            isOwner ? "" : "pointer-events-none opacity-50"
          }`}
        >
          <Upload className="h-3.5 w-3.5" />
          {uploadingTemplate
            ? "Reading…"
            : data?.excelTemplate
              ? "Replace template"
              : "Upload template"}
          <input
            type="file"
            accept=".xlsx"
            className="hidden"
            disabled={!isOwner || uploadingTemplate}
            onChange={(event) => {
              const file = event.target.files?.[0];
              event.target.value = "";
              if (file) void uploadTemplate(file);
            }}
          />
        </label>
      </section>

      <section className="rounded-2xl border border-border bg-card p-5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <p className="text-sm font-semibold">GSTR-2B reconciliation</p>
            <p className="mt-1 max-w-xl text-xs text-muted-foreground">
              Import the 2B downloaded from the GST portal. Bahi matches each line to your purchase
              invoices by GSTIN and invoice number, and flags differences before posting.
            </p>
          </div>
          <span
            className={`rounded-full px-3 py-1 text-[11px] font-medium ${
              data?.gstr2b ? "bg-emerald-500/10 text-emerald-700" : "bg-muted text-muted-foreground"
            }`}
          >
            {data?.gstr2b ? `Last import ${data.gstr2b.period}` : "Not imported"}
          </span>
        </div>

        {data?.gstr2b ? (
          <dl className="mt-4 grid grid-cols-2 gap-3 text-xs sm:grid-cols-4">
            <div className="rounded-xl border border-border bg-background px-3 py-2">
              <dt className="text-muted-foreground">Lines</dt>
              <dd className="mt-0.5 font-semibold">{data.gstr2b.imported}</dd>
            </div>
            <div className="rounded-xl border border-border bg-background px-3 py-2">
              <dt className="text-muted-foreground">Matched</dt>
              <dd className="mt-0.5 font-semibold text-emerald-700">{data.gstr2b.matched}</dd>
            </div>
            <div className="rounded-xl border border-border bg-background px-3 py-2">
              <dt className="text-muted-foreground">Amount differs</dt>
              <dd className="mt-0.5 font-semibold text-amber-700">{data.gstr2b.mismatched}</dd>
            </div>
            <div className="rounded-xl border border-border bg-background px-3 py-2">
              <dt className="text-muted-foreground">Missing from books</dt>
              <dd className="mt-0.5 font-semibold text-destructive">
                {data.gstr2b.missingInBooks}
              </dd>
            </div>
            <p className="col-span-2 text-[11px] text-muted-foreground sm:col-span-4">
              Imported {new Date(data.gstr2b.importedAt).toLocaleString()}
            </p>
          </dl>
        ) : null}

        <div className="mt-4 grid gap-3 sm:grid-cols-[1fr_1.4fr]">
          <label className="block">
            <span className="text-xs font-medium text-muted-foreground">Return period</span>
            <input
              type="month"
              value={gstrPeriod}
              disabled={data?.role === "viewer"}
              onChange={(event) => setGstrPeriod(event.target.value)}
              className={`${inputClass} mt-1`}
            />
            <span className="mt-1.5 block text-[11px] text-muted-foreground">
              Used when the file has no period. The portal file usually includes it.
            </span>
          </label>
          <div className="flex flex-col justify-between gap-2">
            <label
              className={`btn-outline inline-flex h-10 cursor-pointer items-center justify-center gap-2 px-4 text-xs ${
                data?.role === "viewer" ? "pointer-events-none opacity-50" : ""
              }`}
            >
              <Upload className="h-3.5 w-3.5" />
              {importingGstr2b ? "Matching…" : "Import GSTR-2B file"}
              <input
                type="file"
                accept=".json,.csv,.txt"
                className="hidden"
                disabled={data?.role === "viewer" || importingGstr2b}
                onChange={(event) => {
                  const file = event.target.files?.[0];
                  event.target.value = "";
                  if (file) void importGstr(file);
                }}
              />
            </label>
            <p className="text-[11px] text-muted-foreground">
              Accepts the GST portal JSON or a CSV with supplier GSTIN, invoice number and total.
              Matching updates invoices already in Bahi; it never creates or posts a voucher.
            </p>
          </div>
        </div>
      </section>

      <section className="rounded-2xl border border-border bg-card p-5">
        <p className="text-sm font-semibold">Workspace</p>
        <dl className="mt-3 grid gap-3 text-xs sm:grid-cols-3">
          <div>
            <dt className="text-muted-foreground">Plan pack</dt>
            <dd className="mt-1 font-medium capitalize">
              {data?.settings.pack.key} · v{data?.settings.pack.version}
            </dd>
          </div>
          <div>
            <dt className="text-muted-foreground">Your role</dt>
            <dd className="mt-1 font-medium capitalize">{data?.role}</dd>
          </div>
          <div>
            <dt className="text-muted-foreground">GST tolerance</dt>
            <dd className="mt-1 font-medium">
              {formatINR(data?.settings.gst.toleranceMinor ?? 0, 2)}
            </dd>
          </div>
          <div>
            <dt className="text-muted-foreground">Photo &amp; scan reading</dt>
            <dd className="mt-1 font-medium">
              {data?.vision.enabled ? `Vision · ${data.vision.model}` : "Text layer only"}
            </dd>
          </div>
        </dl>
      </section>
    </div>
  );
}

export type { SettingsData };
