/**
 * Rendu Markdown minimal et SÛR (aucun HTML brut interprété) : titres, gras,
 * italique, code, listes, tableaux, blocs de code, liens http(s).
 */
import { Fragment, type ReactNode } from "react";

function inline(text: string, key = 0): ReactNode[] {
  const out: ReactNode[] = [];
  const re = /(\*\*[^*]+\*\*|`[^`]+`|_[^_]+_|\[[^\]]+\]\(https?:\/\/[^)\s]+\))/g;
  let last = 0; let m: RegExpExecArray | null; let i = 0;
  while ((m = re.exec(text))) {
    if (m.index > last) out.push(text.slice(last, m.index));
    const t = m[0];
    if (t.startsWith("**")) out.push(<strong key={`${key}-${i++}`}>{t.slice(2, -2)}</strong>);
    else if (t.startsWith("`")) out.push(<code key={`${key}-${i++}`}>{t.slice(1, -1)}</code>);
    else if (t.startsWith("_")) out.push(<em key={`${key}-${i++}`}>{t.slice(1, -1)}</em>);
    else { const mm = t.match(/\[([^\]]+)\]\(([^)]+)\)/)!; out.push(<a key={`${key}-${i++}`} href={mm[2]} target="_blank" rel="noreferrer noopener" className="text-accent underline">{mm[1]}</a>); }
    last = m.index + t.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

export function Markdown({ text }: { text: string }) {
  const lines = text.split("\n");
  const blocks: ReactNode[] = [];
  let i = 0; let k = 0;
  while (i < lines.length) {
    const l = lines[i];
    if (l.startsWith("```")) {
      const buf: string[] = []; i++;
      while (i < lines.length && !lines[i].startsWith("```")) buf.push(lines[i++]);
      i++; blocks.push(<pre key={k++}>{buf.join("\n")}</pre>); continue;
    }
    if (/^\|.*\|$/.test(l.trim())) {
      const rows: string[][] = [];
      while (i < lines.length && /^\|.*\|$/.test(lines[i].trim())) { if (!/^\|[\s|:-]+\|$/.test(lines[i].trim())) rows.push(lines[i].trim().slice(1, -1).split("|").map((c) => c.trim())); i++; }
      blocks.push(<table key={k++}><tbody>{rows.map((r, ri) => <tr key={ri}>{r.map((c, ci) => ri === 0 ? <th key={ci}>{inline(c)}</th> : <td key={ci}>{inline(c)}</td>)}</tr>)}</tbody></table>); continue;
    }
    if (/^\s*[-*] /.test(l)) {
      const items: string[] = [];
      while (i < lines.length && /^\s*[-*] /.test(lines[i])) items.push(lines[i++].replace(/^\s*[-*] /, ""));
      blocks.push(<ul key={k++}>{items.map((t, j) => <li key={j}>{inline(t, j)}</li>)}</ul>); continue;
    }
    if (/^\d+\. /.test(l)) {
      const items: string[] = [];
      while (i < lines.length && /^\d+\. /.test(lines[i])) items.push(lines[i++].replace(/^\d+\. /, ""));
      blocks.push(<ol key={k++}>{items.map((t, j) => <li key={j}>{inline(t, j)}</li>)}</ol>); continue;
    }
    if (l.startsWith("## ")) blocks.push(<h2 key={k++}>{inline(l.slice(3))}</h2>);
    else if (l.startsWith("### ")) blocks.push(<h3 key={k++}>{inline(l.slice(4))}</h3>);
    else if (l.trim()) blocks.push(<p key={k++}>{inline(l)}</p>);
    i++;
  }
  return <div className="prose-os">{blocks.map((b, j) => <Fragment key={j}>{b}</Fragment>)}</div>;
}
