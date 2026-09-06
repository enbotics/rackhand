import { CommandCenter } from "@/components/warehouse/command-center";

/**
 * The one operator screen (Milestone 10).
 *
 * A Server Component holding no state and no data: everything on the command
 * centre is live, so the interactive tree lives behind a single client
 * boundary below. Nothing server-only — no Prisma client, no Strands SDK, no
 * AWS configuration — is imported into that tree; the browser reaches the
 * warehouse only through the API routes.
 */
export default function Home() {
  return (
    <main className="flex flex-1 flex-col">
      <CommandCenter />
    </main>
  );
}
