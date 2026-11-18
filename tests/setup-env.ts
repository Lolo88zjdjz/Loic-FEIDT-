import "dotenv/config";
// Les tests utilisent TOUJOURS la base de test, jamais la base de travail.
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
process.env.LOIC_OS_ANTHROPIC_API_KEY = ""; // aucun appel facturé pendant les tests
process.env.OLLAMA_DISABLED ??= "1"; // tests d'intégration sans LLM par défaut (voir tests/integration/ollama.test.ts)
process.env.STORAGE_DIR = "./storage-test";
