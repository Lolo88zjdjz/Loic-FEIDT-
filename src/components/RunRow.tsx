"use client";
import { useState } from "react";
import ExecutionGraph from "./ExecutionGraph";

export default function RunRow({ id, children }: { id: string; children: React.ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="border-t border-line py-1.5">
      <button className="w-full text-left" onClick={() => setOpen(!open)}>{children}</button>
      {open && <div className="mt-2 card p-3"><ExecutionGraph runId={id} /></div>}
    </div>
  );
}
