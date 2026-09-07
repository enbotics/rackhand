import { OperateView } from "@/components/warehouse/views/operate";

/**
 * The landing page — the live operating loop (Milestone 10, split in 13).
 *
 * A Server Component holding no state and no data: everything on the command
 * centre is live, so the interactive tree lives behind a single client
 * boundary below. Nothing server-only — no Prisma client, no Strands SDK, no
 * AWS configuration — is imported into that tree; the browser reaches the
 * warehouse only through the API routes.
 */
export default function Home() {
  return <OperateView />;
}
