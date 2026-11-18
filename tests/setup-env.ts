import "dotenv/config";
// Les tests utilisent TOUJOURS la base de test, jamais la base de travail.
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
process.env.ANTHROPIC_API_KEY = ""; // aucun appel facturé pendant les tests
process.env.STORAGE_DIR = "./storage-test";
