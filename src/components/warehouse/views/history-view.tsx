"use client";

import { Gallery } from "@/components/gallery";
import { MovementHistory } from "../movement-history";
import { useWarehouseSession } from "../session";
import { PageShell } from "./shell";

/**
 * HISTORY — what has already happened.
 *
 * TWO DIFFERENT KINDS OF RECORD, and the page says so rather than letting
 * them blur. Movements are warehouse history: every putaway and retrieval
 * that was requested, and whether it completed or failed. Recent scans are
 * photographs in THIS browser — local convenience, never evidence of stock.
 */
export function HistoryView() {
  const session = useWarehouseSession();

  return (
    <PageShell
      title="History"
      intent="What the warehouse did, and what this browser saw."
      footer="Movements are authoritative warehouse history, kept for both outcomes so a failed attempt stays traceable. Recent scans live in this browser only (IndexedDB) and are never inventory."
    >
      <MovementHistory
        movements={session.movements}
        loading={session.loading}
        error={session.overviewError}
        onRetry={session.refresh}
      />
      <Gallery
        shots={session.shots}
        onDelete={session.onDeleteShot}
        onMeasured={session.onMeasured}
      />
    </PageShell>
  );
}
