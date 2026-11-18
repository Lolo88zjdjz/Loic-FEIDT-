import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { pool } from "@/core/db/client";
import { importDocument, searchDocuments } from "@/core/knowledge/service";
import { makeUser } from "../helpers";

let U: { id: string };
beforeAll(async () => { U = await makeUser(); });
afterAll(async () => { await pool.end(); });

describe("extraction PDF et DOCX", () => {
  it("DOCX : extrait, indexe et cite", async () => {
    const r = await importDocument(U.id, { filename: "droit.docx", mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", data: readFileSync("tests/fixtures/droit.docx") });
    expect(r.document.status).toBe("indexed");
    expect(r.document.classification).toBe("droit");
    expect((await searchDocuments(U.id, "offre acceptation"))[0]?.title).toBe("droit");
  });
  it("PDF texte : extrait page par page avec numéro de page", async () => {
    const r = await importDocument(U.id, { filename: "stats.pdf", mimeType: "application/pdf", data: readFileSync("tests/fixtures/stats.pdf") });
    expect(r.document.status).toBe("indexed");
    const hits = await searchDocuments(U.id, "écart-type");
    expect(hits[0]?.page).toBe(2);
    expect((await searchDocuments(U.id, "variance dispersion"))[0]?.page).toBe(1);
  });
});
