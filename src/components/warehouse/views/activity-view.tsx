"use client";

import { AgentActivityPanel } from "../agent-activity";
import { useWarehouseSession } from "../session";
import { PageShell } from "./shell";

/**
 * ACTIVITY — how the agent reached its answer.
 *
 * Observational only. Nothing here is warehouse truth and nothing here can
 * replay an action: the observability API exposes reads and offers no control,
 * by design (Milestone 12).
 *
 * The graph's own steps are already in the timeline as GRAPH_STEP_* events, so
 * the Workflow panel is not repeated here — it belongs on Operate, where a
 * run is watched as it happens.
 */
export function ActivityView() {
  const session = useWarehouseSession();

  return (
    <PageShell
      title="Activity"
      intent="Agent traces: which tools ran, what the graph did, and how long a person took to decide."
      footer="Traces are observational and never authoritative. They hold no credentials, no image data and no model reasoning, and there is no way to re-run an action from this page."
    >
      <AgentActivityPanel
        trace={session.trace}
        error={session.traceError}
        recent={session.recentTraces}
        onSelectTrace={session.selectTrace}
      />
    </PageShell>
  );
}
