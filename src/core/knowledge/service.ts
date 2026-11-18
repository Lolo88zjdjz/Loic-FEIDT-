/**
 * Knowledge Vault : import, conservation de l'original, extraction, découpage,
 * indexation plein texte, recherche avec citations, versions et doublons.
 * Le texte extrait est une DONNÉE NON FIABLE : il est toujours encapsulé
 * (wrapUntrusted) avant d'être transmis à un modèle.
 */
import { mkdir, writeFile, readFile } from "node:fs/promises";
import path from "node:path";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { db, schema } from "../db/client";
import { emit } from "../graph/sync";
import { sha256 } from "../security/crypto";
import { detectInjection } from "../security/injection";
import { AppError, type Sensitivity } from "../shared";

const MAX_BYTES = 20 * 1024 * 1024;
const TEXT_TYPES = /^(text\/|application\/json|application\/csv)/;

export type ExtractResult = { pages: { page: number | null; text: string }[]; status: "indexed" | "unsupported"; note?: string };

export async function extractText(buf: Buffer, mime: string, filename: string): Promise<ExtractResult> {
  const ext = path.extname(filename).toLowerCase();
  if (TEXT_TYPES.test(mime) || [".txt", ".md", ".markdown", ".csv", ".json", ".tsv"].includes(ext)) {
    return { pages: [{ page: null, text: buf.toString("utf8") }], status: "indexed" };
  }
  if (mime === "application/pdf" || ext === ".pdf") {
    const { extractText: pdfText, getDocumentProxy } = await import("unpdf");
    const doc = await getDocumentProxy(new Uint8Array(buf));
    const { text } = await pdfText(doc, { mergePages: false });
    const pages = (text as string[]).map((t, i) => ({ page: i + 1, text: t }));
    const total = pages.reduce((n, p) => n + p.text.trim().length, 0);
    if (total < 20) return { pages: [], status: "unsupported", note: "PDF sans couche texte (scan). OCR non implémenté : l'original est conservé." };
    return { pages, status: "indexed" };
  }
  if (ext === ".docx" || mime === "application/vnd.openxmlformats-officedocument.wordprocessingml.document") {
    const mammoth = await import("mammoth");
    const r = await mammoth.extractRawText({ buffer: buf });
    return { pages: [{ page: null, text: r.value }], status: "indexed" };
  }
  if (mime.startsWith("image/")) return { pages: [], status: "unsupported", note: "Image conservée. OCR non implémenté (prévu : Claude vision si clé API)." };
  if (ext === ".xlsx") return { pages: [], status: "unsupported", note: "XLSX conservé. Extraction tableur non implémentée (prochaine étape)." };
  return { pages: [], status: "unsupported", note: `Format non pris en charge pour l'extraction (${mime || ext}).` };
}

/** Découpage par paragraphes, ~1 200 caractères avec 150 de recouvrement. */
export function chunkText(pages: ExtractResult["pages"], size = 1200, overlap = 150) {
  const chunks: { content: string; charStart: number; charEnd: number; page: number | null }[] = [];
  let offset = 0;
  for (const p of pages) {
    const text = p.text.replace(/\r\n/g, "\n");
    let start = 0;
    while (start < text.length) {
      let end = Math.min(text.length, start + size);
      if (end < text.length) {
        const para = text.lastIndexOf("\n\n", end);
        const sentence = text.lastIndexOf(". ", end);
        const cut = para > start + size * 0.5 ? para : sentence > start + size * 0.5 ? sentence + 1 : end;
        end = cut;
      }
      const content = text.slice(start, end).trim();
      if (content.length > 0) chunks.push({ content, charStart: offset + start, charEnd: offset + end, page: p.page });
      if (end >= text.length) break;
      start = Math.max(end - overlap, start + 1);
    }
    offset += text.length + 1;
  }
  return chunks;
}

/** Résumé extractif déterministe (aucun appel IA) — étiqueté comme tel. */
export function extractiveSummary(text: string, maxChars = 400) {
  const clean = text.replace(/\s+/g, " ").trim();
  if (clean.length <= maxChars) return clean;
  const sentences = clean.split(/(?<=[.!?])\s+/);
  let out = "";
  for (const s of sentences) { if ((out + " " + s).length > maxChars) break; out += (out ? " " : "") + s; }
  return (out || clean.slice(0, maxChars)) + " …";
}

export function classify(text: string, filename: string): string {
  const t = (text.slice(0, 5000) + " " + filename).toLowerCase();
  const rules: [string, RegExp][] = [
    ["finance", /(bilan|compte de résultat|van|tri|cash[- ]flow|actualisation|finance|amortissement|bfr)/],
    ["droit", /(contrat|article \d|jurisprudence|code civil|droit)/],
    ["marketing", /(marketing|segmentation|positionnement|mix|persona)/],
    ["partenariat", /(partenariat|sponsoring|dotation|contrepartie|altigliss)/],
    ["carrière", /(cv|curriculum|lettre de motivation|stage|candidature)/],
    ["voyage", /(thaïlande|thailand|bangkok|vol |itinéraire|réservation)/],
    ["géopolitique", /(géopolitique|geopolitic|relations internationales|otan|onu)/],
  ];
  return rules.find(([, re]) => re.test(t))?.[0] ?? "général";
}

export async function importDocument(ownerId: string, file: {
  filename: string; mimeType: string; data: Buffer; title?: string; projectId?: string | null; sensitivity?: Sensitivity;
}, actor = "user") {
  if (file.data.length === 0) throw new AppError("Fichier vide");
  if (file.data.length > MAX_BYTES) throw new AppError("Fichier trop volumineux (20 Mo max)");
  const safeName = path.basename(file.filename).replace(/[^\w.\- ()À-ÿ]/g, "_").slice(0, 160);
  const hash = sha256(file.data);
  const [dup] = await db.select().from(schema.knowledgeDocuments).where(and(eq(schema.knowledgeDocuments.ownerId, ownerId), eq(schema.knowledgeDocuments.sha256, hash)));
  if (dup) return { document: dup, duplicate: true as const, injectionFlags: [] as string[] };

  const dir = path.resolve(process.env.STORAGE_DIR ?? "./storage", ownerId);
  await mkdir(dir, { recursive: true });
  const storagePath = path.join(dir, `${hash}${path.extname(safeName).toLowerCase()}`);
  await writeFile(storagePath, file.data, { mode: 0o600 });

  let extracted: ExtractResult;
  try { extracted = await extractText(file.data, file.mimeType, safeName); }
  catch (e) { extracted = { pages: [], status: "unsupported", note: `Échec d'extraction : ${(e as Error).message}` }; }
  const fullText = extracted.pages.map((p) => p.text).join("\n");
  const injectionFlags = detectInjection(fullText);

  const [prev] = await db.select().from(schema.knowledgeDocuments).where(and(eq(schema.knowledgeDocuments.ownerId, ownerId), eq(schema.knowledgeDocuments.filename, safeName)))
    .orderBy(desc(schema.knowledgeDocuments.version)).limit(1);

  const document = await db.transaction(async (tx) => {
    const [src] = await tx.insert(schema.sources).values({ ownerId, kind: "document", title: safeName, retrievedAt: new Date(), metadata: { sha256: hash } }).returning();
    const [doc] = await tx.insert(schema.knowledgeDocuments).values({
      ownerId, title: file.title?.trim() || safeName.replace(/\.[^.]+$/, ""), filename: safeName, mimeType: file.mimeType || "application/octet-stream",
      sizeBytes: file.data.length, sha256: hash, storagePath, projectId: file.projectId ?? null, sourceId: src.id,
      status: extracted.status === "indexed" && fullText.trim() ? "indexed" : "unsupported", extractionError: extracted.note ?? null,
      version: prev ? prev.version + 1 : 1, parentDocumentId: prev?.id ?? null,
      summary: fullText.trim() ? extractiveSummary(fullText) : null, classification: classify(fullText, safeName),
      sensitivity: file.sensitivity ?? "personal", charCount: fullText.length,
    }).returning();
    const chunks = chunkText(extracted.pages);
    for (let i = 0; i < chunks.length; i += 200) {
      await tx.insert(schema.knowledgeChunks).values(chunks.slice(i, i + 200).map((c, j) => ({ ...c, documentId: doc.id, ordinal: i + j })));
    }
    await emit(tx, ownerId, actor, { type: "document.upserted", id: doc.id });
    return doc;
  });
  return { document, duplicate: false as const, injectionFlags };
}

export type Citation = { documentId: string; title: string; chunkId: string; ordinal: number; page: number | null; charStart: number; charEnd: number; excerpt: string; score: number };

export async function searchDocuments(ownerId: string, query: string, opts: { limit?: number; documentIds?: string[]; projectId?: string } = {}): Promise<Citation[]> {
  const q = query.trim();
  if (!q) return [];
  const r = await db.execute(sql`
    WITH p AS (SELECT websearch_to_tsquery('french', ${q}) AS tq)
    SELECT c.id, c.document_id, c.ordinal, c.page, c.char_start, c.char_end, c.content, d.title,
      ts_rank_cd(c.search, p.tq) * 2 + word_similarity(${q}, c.content) AS score,
      ts_headline('french', c.content, p.tq, 'MaxWords=40, MinWords=15, StartSel=«, StopSel=»') AS excerpt
    FROM knowledge_chunks c JOIN knowledge_documents d ON d.id = c.document_id, p
    WHERE d.owner_id = ${ownerId}
      ${opts.documentIds?.length ? sql`AND d.id IN (${sql.join(opts.documentIds.map((x) => sql`${x}::uuid`), sql`, `)})` : sql``}
      ${opts.projectId ? sql`AND d.project_id = ${opts.projectId}` : sql``}
      AND (c.search @@ p.tq OR word_similarity(${q}, c.content) > 0.4)
    ORDER BY score DESC LIMIT ${opts.limit ?? 8}`);
  return (r.rows as Record<string, unknown>[]).map((x) => ({
    documentId: x.document_id as string, title: x.title as string, chunkId: x.id as string, ordinal: x.ordinal as number,
    page: (x.page as number) ?? null, charStart: x.char_start as number, charEnd: x.char_end as number,
    excerpt: x.excerpt as string, score: Number(x.score),
  }));
}

export async function getChunks(ids: string[]) {
  if (!ids.length) return [];
  return db.select().from(schema.knowledgeChunks).where(inArray(schema.knowledgeChunks.id, ids));
}

export async function readOriginal(ownerId: string, docId: string) {
  const [d] = await db.select().from(schema.knowledgeDocuments).where(and(eq(schema.knowledgeDocuments.ownerId, ownerId), eq(schema.knowledgeDocuments.id, docId)));
  if (!d) throw new AppError("Document introuvable", "not_found", 404);
  return { doc: d, data: await readFile(d.storagePath) };
}
