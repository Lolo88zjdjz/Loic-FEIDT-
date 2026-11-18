import type { ReactNode } from "react";

export function PageHeader({ title, subtitle, actions }: { title: string; subtitle?: ReactNode; actions?: ReactNode }) {
  return (
    <header className="flex flex-wrap items-end justify-between gap-3 mb-6">
      <div>
        <h1 className="text-[20px] font-semibold tracking-tight">{title}</h1>
        {subtitle && <p className="text-muted text-[13px] mt-1 max-w-3xl">{subtitle}</p>}
      </div>
      {actions && <div className="flex gap-2 flex-wrap">{actions}</div>}
    </header>
  );
}

export function Card({ title, children, className = "", right }: { title?: ReactNode; children: ReactNode; className?: string; right?: ReactNode }) {
  return (
    <section className={`card p-4 ${className}`}>
      {title && <div className="flex items-center justify-between mb-3"><h2 className="text-[13px] font-semibold text-muted uppercase tracking-wide">{title}</h2>{right}</div>}
      {children}
    </section>
  );
}

const TONES: Record<string, string> = {
  neutral: "bg-soft text-muted border-line", ok: "text-ok border-ok/30 bg-ok/10", warn: "text-warn border-warn/30 bg-warn/10",
  bad: "text-bad border-bad/30 bg-bad/10", info: "text-info border-info/30 bg-info/10", accent: "text-accent border-accent/30 bg-accent/10",
};
export function Badge({ children, tone = "neutral", title }: { children: ReactNode; tone?: keyof typeof TONES | string; title?: string }) {
  return <span title={title} className={`inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-[11px] font-medium whitespace-nowrap ${TONES[tone] ?? TONES.neutral}`}>{children}</span>;
}

export function Stat({ label, value, hint }: { label: string; value: ReactNode; hint?: ReactNode }) {
  return (
    <div className="card p-4">
      <div className="text-[12px] text-muted">{label}</div>
      <div className="text-[22px] font-semibold mt-1 tabular-nums">{value}</div>
      {hint && <div className="text-[12px] text-faint mt-1">{hint}</div>}
    </div>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <div className="text-faint text-[13px] py-6 text-center">{children}</div>;
}

export const statusTone = (s: string) =>
  ({ completed: "ok", executed: "ok", active: "ok", installed: "ok", connected: "ok", verified: "ok", confirmed: "ok", agreed: "ok", delivered: "ok", done: "ok", operational: "ok",
     running: "info", queued: "info", doing: "info", negotiating: "info", replied: "info", interview: "info", partial: "warn",
     waiting_approval: "warn", pending: "warn", update_available: "warn", recommended: "accent", estimated: "warn", inferred: "warn", tentative: "warn", skipped: "warn",
     failed: "bad", rejected: "bad", declined: "bad", error: "bad", denied: "bad", incompatible: "bad", planned: "neutral" } as Record<string, string>)[s] ?? "neutral";

export const fmtDate = (d: Date | string | null | undefined, withTime = false) =>
  d ? new Date(d).toLocaleString("fr-FR", withTime ? { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" } : { day: "numeric", month: "short", year: "numeric" }) : "—";
export const usd = (n: number | string) => `${Number(n).toFixed(Number(n) < 0.01 && Number(n) > 0 ? 5 : 4)} $`;
