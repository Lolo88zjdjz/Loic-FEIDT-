"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState } from "react";
import {
  LayoutDashboard, MessageSquare, Network, Bot, Brain, Library, FolderKanban, Users, CalendarDays, Workflow, Puzzle, Coins, Activity, Settings, HeartPulse, Menu, X, Sun, Moon,
} from "lucide-react";

const NAV = [
  ["/", "Dashboard", LayoutDashboard], ["/command", "Command Center", MessageSquare], ["/brain", "Neural Brain", Network], ["/agents", "Agents", Bot],
  ["/memory", "Memory", Brain], ["/vault", "Knowledge Vault", Library], ["/projects", "Projects", FolderKanban], ["/crm", "CRM", Users],
  ["/calendar", "Calendar", CalendarDays], ["/automations", "Automations", Workflow], ["/plugins", "Plugin Center", Puzzle], ["/costs", "AI Cost Center", Coins],
  ["/activity", "Activity", Activity], ["/health", "System Health", HeartPulse], ["/settings", "Settings", Settings],
] as const;

export function Sidebar({ pending, llm, label }: { pending: number; llm: boolean; label: string }) {
  const path = usePathname();
  const [open, setOpen] = useState(false);
  const toggleTheme = () => {
    const next = document.documentElement.dataset.theme === "dark" ? "light" : "dark";
    document.documentElement.dataset.theme = next;
    try { localStorage.setItem("loic-theme", next); } catch {}
  };
  return (
    <>
      <button className="md:hidden fixed top-3 left-3 z-40 btn" onClick={() => setOpen(!open)} aria-label="Menu">{open ? <X size={16} /> : <Menu size={16} />}</button>
      <aside className={`${open ? "translate-x-0" : "-translate-x-full"} md:translate-x-0 transition-transform fixed md:sticky top-0 z-30 h-screen w-[230px] shrink-0 border-r border-line bg-elev flex flex-col`}>
        <div className="px-4 pt-5 pb-4 flex items-center gap-2">
          <span className="size-2.5 rounded-full bg-accent shadow-[0_0_12px_var(--accent)]" />
          <span className="font-semibold tracking-tight">LOÏC OS</span>
          <span className="ml-auto text-[10px] text-faint">v0.1</span>
        </div>
        <nav className="flex-1 overflow-y-auto scroll-thin px-2 space-y-0.5">
          {NAV.map(([href, label, Icon]) => {
            const active = href === "/" ? path === "/" : path.startsWith(href);
            return (
              <Link key={href} href={href} onClick={() => setOpen(false)}
                className={`flex items-center gap-2.5 rounded-md px-2.5 py-1.5 text-[13px] ${active ? "bg-accent-soft text-fg font-medium" : "text-muted hover:text-fg hover:bg-soft"}`}>
                <Icon size={15} strokeWidth={1.8} />{label}
                {href === "/activity" && pending > 0 && <span className="ml-auto rounded bg-warn/20 text-warn text-[10px] px-1.5">{pending}</span>}
              </Link>
            );
          })}
        </nav>
        <div className="p-3 border-t border-line space-y-2 text-[12px]">
          <div className="flex items-center gap-2 text-muted"><span className={`size-1.5 rounded-full ${llm ? "bg-ok" : "bg-warn"}`} />{label}</div>
          <div className="flex gap-2">
            <button onClick={toggleTheme} className="btn flex-1 justify-center" aria-label="Thème"><Sun size={14} className="hidden dark:block" /><Moon size={14} className="dark:hidden" /></button>
            <form action="/api/logout" method="post" className="flex-1"><button className="btn w-full justify-center">Déconnexion</button></form>
          </div>
        </div>
      </aside>
    </>
  );
}
