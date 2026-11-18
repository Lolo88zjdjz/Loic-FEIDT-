/**
 * NUTRI — calculs 100 % déterministes. Les valeurs nutritionnelles portent un
 * statut : « verified » (saisies par l'utilisateur depuis une étiquette) ou
 * « estimated » (référence générique à vérifier). Un total contenant au moins
 * une estimation est lui-même marqué comme estimé.
 */
import { and, eq, sql } from "drizzle-orm";
import { db, schema } from "../db/client";
import { audit } from "../security/audit";
import { AppError, norm, round, todayISO } from "../shared";

export type Macros = { kcal: number; protein: number; carbs: number; fat: number };
export function macrosFor(food: { kcal100g: string | number; protein100g: string | number; carbs100g: string | number; fat100g: string | number }, grams: number): Macros {
  const f = grams / 100;
  return { kcal: round(Number(food.kcal100g) * f), protein: round(Number(food.protein100g) * f), carbs: round(Number(food.carbs100g) * f), fat: round(Number(food.fat100g) * f) };
}

export async function findFood(ownerId: string, query: string) {
  const all = await db.select().from(schema.foods).where(eq(schema.foods.ownerId, ownerId));
  const q = norm(query.trim());
  const exact = all.find((f) => norm(f.name) === q || f.aliases.some((a) => norm(a) === q));
  if (exact) return exact;
  const partial = all.filter((f) => [f.name, ...f.aliases].some((n) => q.includes(norm(n)) || norm(n).includes(q)));
  partial.sort((a, b) => b.name.length - a.name.length);
  return partial[0] ?? null;
}

/** Analyse « 250 g de fromage blanc » / « 150g poulet » → { grams, foodText }. */
export function parseFoodEntry(text: string) {
  const m = text.match(/(\d+(?:[.,]\d+)?)\s*(kg|g|gr|grammes?)\b\s*(?:de |d'|d’)?\s*(.+?)(?:\s+(?:à|a|dans|au|sur)\s+mon\s+journal.*)?$/i);
  if (!m) return null;
  const qty = parseFloat(m[1].replace(",", "."));
  const grams = m[2].toLowerCase() === "kg" ? qty * 1000 : qty;
  return { grams, foodText: m[3].replace(/[.!?]+$/, "").trim() };
}

export async function logFood(ownerId: string, entry: { foodQuery: string; grams: number; eatenOn?: string; meal?: string | null }, actor = "user") {
  if (!(entry.grams > 0 && entry.grams <= 5000)) throw new AppError("Quantité invalide (1 à 5000 g)");
  const food = await findFood(ownerId, entry.foodQuery);
  if (!food) throw new AppError(`Aliment inconnu : « ${entry.foodQuery} ». Ajoutez-le avec ses valeurs pour 100 g (Paramètres → Nutrition).`, "unknown_food");
  const m = macrosFor(food, entry.grams);
  const eatenOn = entry.eatenOn ?? todayISO();
  const [row] = await db.insert(schema.foodLog).values({
    ownerId, foodId: food.id, eatenOn, meal: entry.meal ?? null, grams: String(entry.grams),
    kcal: String(m.kcal), protein: String(m.protein), carbs: String(m.carbs), fat: String(m.fat), dataStatus: food.dataStatus,
  }).returning();
  await audit(db, { ownerId, actor, action: "nutrition.log", entityType: "food_log", entityId: row.id, details: { food: food.name, grams: entry.grams } });
  return { entry: row, food, macros: m, day: await dayTotals(ownerId, eatenOn) };
}

export async function dayTotals(ownerId: string, day: string) {
  const r = await db.execute(sql`SELECT coalesce(sum(kcal),0)::float AS kcal, coalesce(sum(protein),0)::float AS protein,
      coalesce(sum(carbs),0)::float AS carbs, coalesce(sum(fat),0)::float AS fat, count(*)::int AS entries,
      bool_or(data_status = 'estimated') AS has_estimates
    FROM food_log WHERE owner_id = ${ownerId} AND eaten_on = ${day}`);
  const t = r.rows[0] as Macros & { entries: number; has_estimates: boolean | null };
  return { day, kcal: round(t.kcal), protein: round(t.protein), carbs: round(t.carbs), fat: round(t.fat), entries: t.entries, status: t.has_estimates ? "estimated" : t.entries ? "verified" : "empty" };
}

export async function dayLog(ownerId: string, day: string) {
  return db.select({ log: schema.foodLog, food: schema.foods.name }).from(schema.foodLog)
    .innerJoin(schema.foods, eq(schema.foods.id, schema.foodLog.foodId))
    .where(and(eq(schema.foodLog.ownerId, ownerId), eq(schema.foodLog.eatenOn, day)));
}

export async function upsertFood(ownerId: string, f: { name: string; kcal100g: number; protein100g: number; carbs100g: number; fat100g: number; dataStatus: "verified" | "estimated"; sourceNote: string; aliases?: string[] }) {
  for (const k of ["kcal100g", "protein100g", "carbs100g", "fat100g"] as const) if (!(f[k] >= 0)) throw new AppError(`Valeur invalide : ${k}`);
  if (f.protein100g + f.carbs100g + f.fat100g > 100.5) throw new AppError("Protéines + glucides + lipides > 100 g pour 100 g");
  const values = { name: f.name, aliases: f.aliases ?? [], kcal100g: String(f.kcal100g), protein100g: String(f.protein100g),
    carbs100g: String(f.carbs100g), fat100g: String(f.fat100g), dataStatus: f.dataStatus, sourceNote: f.sourceNote };
  const [existing] = await db.select().from(schema.foods).where(and(eq(schema.foods.ownerId, ownerId), sql`lower(${schema.foods.name}) = lower(${f.name})`));
  const [row] = existing
    ? await db.update(schema.foods).set(values).where(eq(schema.foods.id, existing.id)).returning()
    : await db.insert(schema.foods).values({ ...values, ownerId }).returning();
  return row;
}
