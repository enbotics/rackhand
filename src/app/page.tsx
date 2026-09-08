import { WarehouseView } from "@/components/warehouse/views/warehouse-view";

/**
 * The landing page — authoritative warehouse state with the orchestrator in
 * the operator's line of sight. Scanning lives at /scan.
 *
 * A Server Component holding no state and no data: everything on the command
 * centre is live, so the interactive tree lives behind a single client
 * boundary below. Nothing server-only — no Prisma client, no Strands SDK, no
 * AWS configuration — is imported into that tree; the browser reaches the
 * warehouse only through the API routes.
 */
export default function Home() {
  return <WarehouseView />;
}
