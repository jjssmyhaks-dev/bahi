import { useState } from "react";
import { Link, useNavigate } from "@tanstack/react-router";
import {
  Activity,
  AlertTriangle,
  Bot,
  ChartNoAxesColumn,
  Inbox,
  Loader2,
  LogOut,
  MessageSquare,
  Plus,
  Settings,
} from "lucide-react";

import { LogoMark } from "@/components/brand";
import { initials } from "@/lib/format";
import type { Workspace } from "@/lib/types";
import { logoutFn, newChatFn } from "@/lib/api";

function NavItem({
  to,
  label,
  icon,
  count,
  active,
  onNavigate,
}: {
  to: string;
  label: string;
  icon: React.ReactNode;
  count?: number | undefined;
  active: boolean;
  onNavigate?: (() => void) | undefined;
}) {
  return (
    <a
      href={to}
      onClick={onNavigate}
      className={`flex items-center gap-2.5 rounded-full px-3.5 py-2.5 text-sm transition-colors ${
        active
          ? "bg-foreground font-medium text-background"
          : "text-foreground/80 hover:bg-muted hover:text-foreground"
      }`}
    >
      <span className={active ? "text-background" : "text-muted-foreground"}>{icon}</span>
      <span className="flex-1">{label}</span>
      {count ? (
        <span
          className={`inline-flex min-w-5 items-center justify-center rounded-full px-1.5 py-0.5 text-[10px] font-semibold ${
            active ? "bg-background text-foreground" : "bg-chip text-chip-foreground"
          }`}
        >
          {count}
        </span>
      ) : null}
    </a>
  );
}

export function SidebarContent({
  workspace,
  pathname,
  onNavigate,
}: {
  workspace: Workspace | undefined;
  pathname: string;
  onNavigate?: () => void;
}) {
  const navigate = useNavigate();
  const [creating, setCreating] = useState(false);

  async function startChat() {
    setCreating(true);
    try {
      const { chatId } = await newChatFn();
      onNavigate?.();
      await navigate({ to: "/app", search: { chat: chatId } });
    } finally {
      setCreating(false);
    }
  }

  async function logout() {
    await logoutFn();
    window.location.assign("/");
  }

  const autonomy = workspace?.tenant.autonomyMode === "autonomous";
  const killed = workspace?.tenant.killSwitch;

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between px-2">
        <a href="/app" className="flex items-center gap-2.5">
          <LogoMark />
          <span className="text-lg font-semibold tracking-tight">Bahi</span>
        </a>
        <span
          className={`rounded-full px-2.5 py-1 text-[10px] font-semibold uppercase tracking-wide ${
            killed
              ? "bg-destructive/10 text-destructive"
              : autonomy
                ? "bg-chip text-chip-foreground"
                : "bg-muted text-muted-foreground"
          }`}
        >
          {killed ? "Paused" : autonomy ? "Autonomous" : "Draft"}
        </span>
      </div>

      <p className="mt-5 truncate px-2 text-xs text-muted-foreground">
        {workspace?.tenant.name ?? "Loading workspace…"}
      </p>

      <button
        type="button"
        onClick={startChat}
        disabled={creating}
        className="btn-primary mt-4 h-10 w-full px-4 text-sm"
      >
        {creating ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}
        {creating ? "Starting…" : "New conversation"}
      </button>

      <nav className="mt-4 space-y-1">
        <NavItem
          to="/app"
          label="Conversations"
          icon={<MessageSquare className="h-4 w-4" />}
          active={pathname === "/app"}
          onNavigate={onNavigate}
        />
        <NavItem
          to="/app/queue"
          label="Review queue"
          icon={<Inbox className="h-4 w-4" />}
          count={workspace?.counts.pending}
          active={pathname === "/app/queue"}
          onNavigate={onNavigate}
        />
        <NavItem
          to="/app/exceptions"
          label="Exceptions"
          icon={<AlertTriangle className="h-4 w-4" />}
          count={workspace?.counts.exceptions}
          active={pathname === "/app/exceptions"}
          onNavigate={onNavigate}
        />
        <NavItem
          to="/app/activity"
          label="Activity"
          icon={<Activity className="h-4 w-4" />}
          active={pathname === "/app/activity"}
          onNavigate={onNavigate}
        />
        <NavItem
          to="/app/insights"
          label="Insights"
          icon={<ChartNoAxesColumn className="h-4 w-4" />}
          active={pathname === "/app/insights"}
          onNavigate={onNavigate}
        />
        <NavItem
          to="/app/agents"
          label="Agents"
          icon={<Bot className="h-4 w-4" />}
          active={pathname === "/app/agents"}
          onNavigate={onNavigate}
        />
        <NavItem
          to="/app/settings"
          label="Settings"
          icon={<Settings className="h-4 w-4" />}
          active={pathname === "/app/settings"}
          onNavigate={onNavigate}
        />
      </nav>

      <div className="mt-6 min-h-0 flex-1 overflow-y-auto">
        <p className="px-2 text-[10px] font-semibold uppercase tracking-widest text-muted-foreground">
          Recent
        </p>
        <div className="mt-2 space-y-0.5">
          {(workspace?.chats ?? []).slice(0, 10).map((chat) => (
            <Link
              key={chat.id}
              to="/app"
              search={{ chat: chat.id }}
              onClick={onNavigate}
              className="block rounded-xl px-3 py-2 transition-colors hover:bg-muted"
            >
              <p className="truncate text-xs font-medium">{chat.title}</p>
              <p className="truncate text-[11px] text-muted-foreground">{chat.preview}</p>
            </Link>
          ))}
          {workspace && workspace.chats.length === 0 ? (
            <p className="px-3 py-2 text-xs text-muted-foreground">No conversations yet.</p>
          ) : null}
        </div>
      </div>

      <div className="mt-4 border-t border-border pt-4">
        <div className="flex items-center gap-2.5 px-2">
          <span className="inline-flex h-8 w-8 items-center justify-center rounded-full bg-secondary text-[11px] font-bold text-secondary-foreground">
            {workspace ? initials(workspace.user.name) : "—"}
          </span>
          <div className="min-w-0 flex-1">
            <p className="truncate text-xs font-medium">{workspace?.user.name ?? "—"}</p>
            <p className="truncate text-[11px] capitalize text-muted-foreground">
              {workspace?.user.role ?? "member"}
            </p>
          </div>
          <button
            type="button"
            onClick={logout}
            aria-label="Log out"
            className="rounded-full p-1.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          >
            <LogOut className="h-4 w-4" />
          </button>
        </div>
      </div>
    </div>
  );
}
