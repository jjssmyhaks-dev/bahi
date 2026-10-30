import { createFileRoute, Outlet, redirect, useRouterState } from "@tanstack/react-router";
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Menu } from "lucide-react";

import { SidebarContent } from "@/components/app/sidebar";
import { LogoMark } from "@/components/brand";
import { Sheet, SheetContent, SheetTitle } from "@/components/ui/sheet";
import { getViewerFn, workspaceFn } from "@/lib/api";
import { PERMISSION_SHORT_LABELS } from "@/lib/permissions";

export const Route = createFileRoute("/app")({
  head: () => ({ meta: [{ title: "Workspace — Bahi" }] }),
  beforeLoad: async () => {
    const viewer = await getViewerFn();
    if (!viewer) throw redirect({ to: "/login" });
    return { viewer };
  },
  component: AppLayout,
});

function AppLayout() {
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const [menuOpen, setMenuOpen] = useState(false);
  const workspace = useQuery({
    queryKey: ["workspace"],
    queryFn: () => workspaceFn(),
    staleTime: 20_000,
  });

  const paused = workspace.data?.tenant.killSwitch;
  const level = workspace.data?.tenant.settings.permissions.level;
  const levelLabel = level ? PERMISSION_SHORT_LABELS[level] : "Auto";

  return (
    <div className="min-h-screen bg-background text-foreground">
      <aside className="fixed inset-y-0 left-0 z-30 hidden w-[264px] border-r border-border bg-background px-4 py-5 lg:block">
        <SidebarContent workspace={workspace.data} pathname={pathname} />
      </aside>

      <header className="sticky top-0 z-20 flex h-14 items-center justify-between border-b border-border bg-background/90 px-4 backdrop-blur-md lg:hidden">
        <button
          type="button"
          onClick={() => setMenuOpen(true)}
          aria-label="Open menu"
          className="rounded-full p-2 text-foreground hover:bg-muted"
        >
          <Menu className="h-5 w-5" />
        </button>
        <a href="/app" className="flex items-center gap-2">
          <LogoMark size={22} />
          <span className="text-base font-semibold tracking-tight">Bahi</span>
        </a>
        <span
          className={`rounded-full px-2.5 py-1 text-[10px] font-semibold uppercase tracking-wide ${
            paused || level === "full"
              ? "bg-destructive/10 text-destructive"
              : "bg-muted text-muted-foreground"
          }`}
        >
          {paused ? "Paused" : levelLabel}
        </span>
      </header>

      <Sheet open={menuOpen} onOpenChange={setMenuOpen}>
        <SheetContent
          side="left"
          className="w-[290px] border-r border-border bg-background px-4 py-5"
        >
          <SheetTitle className="sr-only">Workspace navigation</SheetTitle>
          <SidebarContent
            workspace={workspace.data}
            pathname={pathname}
            onNavigate={() => setMenuOpen(false)}
          />
        </SheetContent>
      </Sheet>

      <div className="lg:pl-[264px]">
        <main className="mx-auto w-full max-w-6xl px-4 py-6 sm:px-8 sm:py-8">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
