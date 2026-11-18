"use client";
import { useRouter } from "next/navigation";
import { useState } from "react";

export default function Uploader({ projects }: { projects: { id: string; name: string }[] }) {
  const router = useRouter();
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault(); setBusy(true); setMsg(null);
    const r = await fetch("/api/vault/upload", { method: "POST", body: new FormData(e.currentTarget) });
    const j = await r.json(); setBusy(false);
    setMsg(j.error ?? (j.results as { title: string; status: string; duplicate: boolean; note: string | null; injectionSuspected: boolean }[]).map((x) => `${x.title} : ${x.duplicate ? "doublon (déjà présent)" : x.status}${x.note ? ` — ${x.note}` : ""}${x.injectionSuspected ? " — ⚠️ instructions suspectes détectées (traitées comme données)" : ""}`).join(" · "));
    router.refresh();
  }
  return (
    <form onSubmit={onSubmit} className="space-y-2 text-[13px]">
      <input type="file" name="file" multiple required className="block w-full text-[12px]" data-testid="vault-file" accept=".pdf,.docx,.txt,.md,.csv,.json,.xlsx,image/*" />
      <div className="flex gap-2">
        <select name="projectId" className="input"><option value="">Sans projet</option>{projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select>
        <select name="sensitivity" className="input w-32"><option>personal</option><option>public</option><option>private</option><option>sensitive</option></select>
      </div>
      <button className="btn btn-primary" disabled={busy} data-testid="vault-upload">{busy ? "Import…" : "Importer"}</button>
      {msg && <p className="text-[12px] text-muted" data-testid="vault-msg">{msg}</p>}
    </form>
  );
}
