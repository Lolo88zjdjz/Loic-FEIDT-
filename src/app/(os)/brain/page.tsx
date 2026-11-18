import { requireUser } from "@/lib/auth";
import BrainGraph from "@/components/BrainGraph";
import { PageHeader } from "@/components/ui";

export default async function BrainPage({ searchParams }: { searchParams: Promise<{ focus?: string; types?: string }> }) {
  await requireUser();
  const { focus, types } = await searchParams;
  return (
    <>
      <PageHeader title="Neural Brain" subtitle="Votre graphe de connaissances réel : chaque point est une entité stockée, chaque lien une relation avec sa provenance. Cliquez un nœud ou une relation pour l'expliquer." />
      <BrainGraph initialFocus={focus} initialTypes={types?.split(",")} />
    </>
  );
}
