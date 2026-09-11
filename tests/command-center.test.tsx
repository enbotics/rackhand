// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { WarehouseNav } from "@/components/warehouse/nav";
import { WarehouseSessionProvider } from "@/components/warehouse/session";
import { OperateView } from "@/components/warehouse/views/operate";
import { WarehouseView } from "@/components/warehouse/views/warehouse-view";
import { HistoryView } from "@/components/warehouse/views/history-view";
import { ActivityView } from "@/components/warehouse/views/activity-view";
import { CurrentScanPanel } from "@/components/warehouse/current-scan-panel";
import { CatalogResolutionCard } from "@/components/warehouse/catalog-resolution-card";
import type { WarehouseOverview } from "@/lib/warehouse/dashboard-types";
import type { GantryStatus } from "@/lib/gantry/types";
import type { ScanState } from "@/components/warehouse/state";

vi.mock("next/navigation", () => ({ usePathname: () => "/" }));
vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

/**
 * The Milestone 10 command centre, rendered.
 *
 * Milestone 13 split it across four routes. These tests render the WHOLE
 * surface — every view inside one session provider — because that is what
 * they were always asserting: that one operator session behaves correctly
 * end to end. Which page a panel now lives on is a layout decision; that an
 * approved action refreshes bins, inventory AND history is not.
 *
 * Every server call is stubbed, so what these tests actually assert is what
 * the dashboard DOES WITH a server answer: that bin status comes from the
 * snapshot rather than from occupancy, that an approved action is reported
 * from the Movement table rather than from the button that was pressed, that a
 * human-confirmed identity never reads as a match, and that losing the model
 * or the camera does not take the rest of the screen down.
 */

/* ------------------------------------------------------------------ fixtures */

function emptyOverview(): WarehouseOverview {
  return {
    generatedAt: 1_700_000_000_000,
    bins: ["B1-01", "B1-02", "B1-03", "B1-04", "B1-05", "B2-01"].map((code) => ({
      binId: `bin_${code}`,
      code,
      status: "AVAILABLE" as const,
      capacity: 100,
      contents: [],
      totalQuantity: 0,
    })),
    inventory: [],
    movements: [],
    totals: { units: 0, distinctParts: 0, binsAvailable: 6, binsOccupied: 0 },
  };
}

function stockedOverview(): WarehouseOverview {
  const overview = emptyOverview();
  overview.bins = overview.bins.map((bin) => {
    if (bin.code === "B1-02") return { ...bin, status: "RESERVED" as const };
    if (bin.code === "B1-03") return { ...bin, status: "DISABLED" as const };
    if (bin.code === "B2-01") {
      return {
        ...bin,
        status: "OCCUPIED" as const,
        totalQuantity: 2,
        contents: [
          {
            partId: "p_brg",
            sku: "BRG-6204",
            canonicalName: "6204 Deep Groove Ball Bearing",
            quantity: 2,
            imageUrl: null,
          },
        ],
      };
    }
    return bin;
  });
  overview.inventory = [
    {
      partId: "p_brg",
      sku: "BRG-6204",
      canonicalName: "6204 Deep Groove Ball Bearing",
      category: "bearing",
      totalQuantity: 3,
      locations: [
        { binCode: "B1-01", quantity: 1 },
        { binCode: "B2-01", quantity: 2 },
      ],
    },
    {
      partId: "p_bolt",
      sku: "BOLT-M8-50",
      canonicalName: "M8 x 50 Hex Bolt",
      category: "fastener",
      totalQuantity: 5,
      locations: [{ binCode: "B1-04", quantity: 5 }],
    },
  ];
  overview.movements = [
    {
      id: "m1",
      type: "PUTAWAY",
      status: "COMPLETED",
      sku: "BRG-6204",
      canonicalName: "6204 Deep Groove Ball Bearing",
      quantity: 1,
      source: "INTAKE",
      destination: "B2-01",
      createdAt: 1_700_000_000_000,
      completedAt: 1_700_000_001_000,
    },
    {
      id: "m2",
      type: "RETRIEVAL",
      status: "FAILED",
      sku: "BOLT-M8-50",
      canonicalName: "M8 x 50 Hex Bolt",
      quantity: 1,
      source: "B1-04",
      destination: "OUTPUT",
      createdAt: 1_699_999_000_000,
      completedAt: 1_699_999_001_000,
    },
  ];
  overview.totals = { units: 8, distinctParts: 2, binsAvailable: 3, binsOccupied: 1 };
  return overview;
}

const IDLE_GANTRY: GantryStatus = {
  mode: "SIMULATION",
  state: "IDLE",
  currentLocation: null,
  homed: true,
  activeOperationId: null,
  lastError: null,
};

const RETRIEVAL_APPROVAL = {
  status: "APPROVAL_REQUIRED",
  message: "Approval required: RETRIEVAL of BRG-6204. Nothing has been moved yet.",
  agent: "warehouse-agent",
  model: "test-model",
  toolCalls: ["search_inventory"],
  approval: {
    approvalId: "approval_test_1",
    action: "execute_retrieval",
    summary: {
      action: "RETRIEVAL",
      sku: "BRG-6204",
      canonicalName: "6204 Deep Groove Ball Bearing",
      source: "B2-01",
      destination: "OUTPUT",
      quantity: 1,
    },
    expiresAt: new Date(Date.now() + 300_000).toISOString(),
  },
};

/* -------------------------------------------------------------- fetch harness */

interface StubResponse {
  status: number;
  body: unknown;
}

let overviewResponse: WarehouseOverview;
let gantryResponse: GantryStatus;
let agentResponse: StubResponse;
let approveResponse: StubResponse;
let traceResponse: unknown;
let recentTracesResponse: unknown[];
let requests: Array<{ url: string; body: unknown }>;

function stubResponse({ status, body }: StubResponse): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as Response;
}

beforeEach(() => {
  overviewResponse = emptyOverview();
  gantryResponse = IDLE_GANTRY;
  agentResponse = {
    status: 200,
    body: {
      status: "COMPLETED",
      message: "BRG-6204 is stored in B2-01.",
      agent: "warehouse-agent",
      model: "test-model",
      toolCalls: ["search_inventory"],
    },
  };
  approveResponse = { status: 200, body: {} };
  traceResponse = null;
  recentTracesResponse = [];
  requests = [];

  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : String(input);
      requests.push({ url, body: init?.body ? JSON.parse(String(init.body)) : undefined });

      if (url.startsWith("/api/warehouse/overview")) {
        return stubResponse({ status: 200, body: overviewResponse });
      }
      if (url.startsWith("/api/gantry/status")) {
        return stubResponse({ status: 200, body: gantryResponse });
      }
      if (url.startsWith("/api/observability/traces?")) {
        return stubResponse({ status: 200, body: { traces: recentTracesResponse } });
      }
      if (url.startsWith("/api/observability/traces/")) {
        return traceResponse
          ? stubResponse({ status: 200, body: traceResponse })
          : stubResponse({ status: 404, body: {} });
      }
      if (url === "/api/agent") return stubResponse(agentResponse);
      if (url === "/api/agent/approve") return stubResponse(approveResponse);
      return stubResponse({ status: 404, body: {} });
    }),
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function panel(title: string): HTMLElement {
  // getAllBy rather than getBy so a panel that later appears on two pages does
  // not break every test that reaches into it.
  const heading = screen.getAllByRole("heading", { name: title })[0];
  if (!heading) throw new Error(`No panel found for "${title}"`);
  const section = heading.closest("section");
  if (!section) throw new Error(`No panel found for "${title}"`);
  return section as HTMLElement;
}

/**
 * Every view, in one session, so a panel's page is a layout detail here and
 * the assertions stay about behaviour.
 */
function AllViews() {
  return (
    <WarehouseSessionProvider>
      <WarehouseNav />
      <OperateView />
      <WarehouseView />
      <HistoryView />
      <ActivityView />
    </WarehouseSessionProvider>
  );
}

async function renderDashboard() {
  render(<AllViews />);
  // Wait for the first authoritative snapshot rather than asserting against a
  // loading frame.
  await waitFor(() => expect(screen.getByRole("heading", { name: "Inventory" })).toBeTruthy());
}

async function askAgent(message: string) {
  fireEvent.change(screen.getByLabelText("Message the warehouse agent"), {
    target: { value: message },
  });
  fireEvent.click(screen.getByRole("button", { name: "Send" }));
}

/* -------------------------------------------------------------------- tests */

describe("command centre — initial state", () => {
  it("renders every dashboard area without needing a current scan", async () => {
    await renderDashboard();

    expect(screen.getByText("RackHand")).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Operate" })).toBeTruthy();
    for (const title of [
      "Live camera",
      "Current scan",
      "Warehouse agent",
      "Digital warehouse",
      "Inventory",
      "Gantry",
      "Recent movements",
      "Agent activity",
      "Recent scans",
    ]) {
      expect(screen.getAllByRole("heading", { name: title }).length).toBeGreaterThan(0);
    }

    // Every section of the menu is reachable from every page. Scoped to the
    // nav landmark: the brand link also contains the word "Warehouse".
    const menu = screen.getByRole("navigation", { name: "Command centre sections" });
    for (const label of ["Operate", "Warehouse", "History", "Activity"]) {
      expect(within(menu).getByRole("link", { name: new RegExp(label) })).toBeTruthy();
    }

    expect(screen.getByRole("button", { name: /Scan Part/ })).toBeTruthy();
    expect(within(panel("Current scan")).getByText(/No current scan/)).toBeTruthy();
    // Simulation is never hidden.
    expect(screen.getByText(/GANTRY MODE: SIMULATION/)).toBeTruthy();
  });

  it("shows friendly empty states instead of blank panels", async () => {
    await renderDashboard();

    await waitFor(() =>
      expect(within(panel("Inventory")).getByText(/No inventory stored yet/)).toBeTruthy(),
    );
    expect(within(panel("Recent movements")).getByText(/No warehouse movements yet/)).toBeTruthy();
    expect(within(panel("Human decisions")).getByText(/Nothing is waiting on you/)).toBeTruthy();
    expect(within(panel("Workflow")).getByText(/No warehouse workflow has run yet/)).toBeTruthy();
    expect(within(panel("Agent activity")).getByText(/No agent activity yet/)).toBeTruthy();
    expect(within(panel("Digital warehouse")).getAllByText("Empty")).toHaveLength(6);
  });
});

describe("command centre — authoritative warehouse state", () => {
  beforeEach(() => {
    overviewResponse = stockedOverview();
  });

  it("draws each bin's status from the server, not from whether it holds stock", async () => {
    await renderDashboard();
    const map = within(panel("Digital warehouse"));

    await waitFor(() => expect(map.getByText("OCCUPIED")).toBeTruthy());
    expect(map.getAllByText("AVAILABLE")).toHaveLength(3);
    expect(map.getByText("RESERVED")).toBeTruthy();
    expect(map.getByText("DISABLED")).toBeTruthy();

    // The occupied bin names its contents; the reserved bin is empty and still
    // not available — two separate facts the map must not merge.
    expect(map.getByText("BRG-6204")).toBeTruthy();
    expect(map.getByText("Qty: 2")).toBeTruthy();
    expect(map.getAllByText("Empty")).toHaveLength(5);
  });

  it("shows authoritative quantities and every bin a part sits in", async () => {
    await renderDashboard();
    const inventory = within(panel("Inventory"));

    await waitFor(() => expect(inventory.getByText("BRG-6204")).toBeTruthy());
    expect(inventory.getByText("Qty 3")).toBeTruthy();
    expect(inventory.getByText("B1-01 (1), B2-01 (2)")).toBeTruthy();
    expect(inventory.getByText("Qty 5")).toBeTruthy();
    expect(inventory.getByText("B1-04")).toBeTruthy();
  });

  it("filters inventory on screen without re-querying the warehouse", async () => {
    await renderDashboard();
    const inventory = within(panel("Inventory"));
    await waitFor(() => expect(inventory.getByText("BOLT-M8-50")).toBeTruthy());

    const before = requests.filter((request) => request.url.startsWith("/api/warehouse")).length;
    fireEvent.change(screen.getByLabelText("Search inventory"), { target: { value: "bearing" } });

    expect(inventory.getByText("BRG-6204")).toBeTruthy();
    expect(inventory.queryByText("BOLT-M8-50")).toBeNull();
    expect(
      requests.filter((request) => request.url.startsWith("/api/warehouse")).length,
    ).toBe(before);
  });

  it("shows recent movements with their real outcomes", async () => {
    await renderDashboard();
    const history = within(panel("Recent movements"));

    await waitFor(() => expect(history.getByText("COMPLETED")).toBeTruthy());
    expect(history.getByText("FAILED")).toBeTruthy();
    expect(history.getByText("BRG-6204")).toBeTruthy();
    expect(history.getByText("INTAKE → B2-01")).toBeTruthy();
  });
});

describe("command centre — approval", () => {
  beforeEach(() => {
    overviewResponse = stockedOverview();
    agentResponse = { status: 200, body: RETRIEVAL_APPROVAL };
  });

  it("shows an approval card with approve and deny when the agent is interrupted", async () => {
    await renderDashboard();
    await askAgent("Bring me BRG-6204.");

    await waitFor(() => expect(screen.getByRole("heading", { name: "Approval required" })).toBeTruthy());
    const card = within(panel("Approval required"));
    expect(card.getByText("RETRIEVAL")).toBeTruthy();
    expect(card.getByText("BRG-6204")).toBeTruthy();
    expect(card.getByText("B2-01 → OUTPUT")).toBeTruthy();
    expect(card.getByRole("button", { name: "Approve" })).toBeTruthy();
    expect(card.getByRole("button", { name: "Deny" })).toBeTruthy();
    // Nothing may have executed yet.
    expect(card.getByText(/Nothing has moved yet/)).toBeTruthy();
    expect(requests.some((request) => request.url === "/api/agent/approve")).toBe(false);
  });

  it("sends only an id and a decision — the card offers no argument channel", async () => {
    await renderDashboard();
    await askAgent("Bring me BRG-6204.");
    await waitFor(() => expect(screen.getByRole("button", { name: "Approve" })).toBeTruthy());

    approveResponse = {
      status: 200,
      body: { status: "COMPLETED", message: "Retrieved.", toolCalls: ["execute_retrieval"] },
    };
    fireEvent.click(screen.getByRole("button", { name: "Approve" }));

    await waitFor(() =>
      expect(requests.some((request) => request.url === "/api/agent/approve")).toBe(true),
    );
    const decision = requests.find((request) => request.url === "/api/agent/approve")!;
    expect(decision.body).toEqual({ approvalId: "approval_test_1", decision: "APPROVE" });
  });

  it("reports the outcome from the refreshed Movement record, not from the click", async () => {
    await renderDashboard();
    await askAgent("Bring me BRG-6204.");
    await waitFor(() => expect(screen.getByRole("button", { name: "Approve" })).toBeTruthy());

    // The server accepted the decision, but the machine failed. An approved
    // action that failed must never render as a success.
    approveResponse = {
      status: 200,
      body: { status: "COMPLETED", message: "The retrieval could not be completed.", toolCalls: [] },
    };
    const after = stockedOverview();
    after.movements = [
      {
        id: "m3",
        type: "RETRIEVAL",
        status: "FAILED",
        sku: "BRG-6204",
        canonicalName: "6204 Deep Groove Ball Bearing",
        quantity: 1,
        source: "B2-01",
        destination: "OUTPUT",
        createdAt: 1_700_000_100_000,
        completedAt: 1_700_000_101_000,
      },
      ...after.movements,
    ];
    overviewResponse = after;

    fireEvent.click(screen.getByRole("button", { name: "Approve" }));

    await waitFor(() => expect(screen.getByRole("heading", { name: "Approval" })).toBeTruthy());
    const card = within(panel("Approval"));
    await waitFor(() => expect(card.getByText("FAILED")).toBeTruthy());
    expect(card.queryByText("COMPLETED")).toBeNull();
  });

  it("refreshes bins, inventory and history after a successful action", async () => {
    await renderDashboard();
    await askAgent("Bring me BRG-6204.");
    await waitFor(() => expect(screen.getByRole("button", { name: "Approve" })).toBeTruthy());

    const after = emptyOverview();
    after.bins = after.bins.map((bin) =>
      bin.code === "B1-05"
        ? {
            ...bin,
            status: "OCCUPIED" as const,
            totalQuantity: 1,
            contents: [
              { partId: "p_new", sku: "NEW-0001", canonicalName: "Newly stored part", quantity: 1, imageUrl: null },
            ],
          }
        : bin,
    );
    after.inventory = [
      {
        partId: "p_new",
        sku: "NEW-0001",
        canonicalName: "Newly stored part",
        category: null,
        totalQuantity: 1,
        locations: [{ binCode: "B1-05", quantity: 1 }],
      },
    ];
    after.movements = [
      {
        id: "m9",
        type: "PUTAWAY",
        status: "COMPLETED",
        sku: "NEW-0001",
        canonicalName: "Newly stored part",
        quantity: 1,
        source: "INTAKE",
        destination: "B1-05",
        createdAt: 1_700_000_200_000,
        completedAt: 1_700_000_201_000,
      },
    ];
    overviewResponse = after;
    approveResponse = {
      status: 200,
      body: { status: "COMPLETED", message: "Stored.", toolCalls: ["execute_putaway"] },
    };

    fireEvent.click(screen.getByRole("button", { name: "Approve" }));

    // No reload: the same mounted dashboard shows the new warehouse state.
    await waitFor(() =>
      expect(within(panel("Inventory")).getByText("NEW-0001")).toBeTruthy(),
    );
    expect(within(panel("Digital warehouse")).getByText("OCCUPIED")).toBeTruthy();
    expect(within(panel("Recent movements")).getByText("INTAKE → B1-05")).toBeTruthy();
  });

  it("cancels on denial and shows no success anywhere", async () => {
    await renderDashboard();
    await askAgent("Bring me BRG-6204.");
    await waitFor(() => expect(screen.getByRole("button", { name: "Deny" })).toBeTruthy());

    approveResponse = {
      status: 200,
      body: {
        status: "COMPLETED",
        message: "Cancelled. The operation was not approved, so nothing was moved.",
        toolCalls: [],
      },
    };
    fireEvent.click(screen.getByRole("button", { name: "Deny" }));

    await waitFor(() => expect(screen.getByText(/Cancelled by operator/)).toBeTruthy());
    const card = within(panel("Approval"));
    expect(card.queryByRole("button", { name: "Approve" })).toBeNull();
    expect(card.queryByText("COMPLETED")).toBeNull();
  });

  it("explains an expired approval instead of retrying it", async () => {
    await renderDashboard();
    await askAgent("Bring me BRG-6204.");
    await waitFor(() => expect(screen.getByRole("button", { name: "Approve" })).toBeTruthy());

    approveResponse = {
      status: 409,
      body: { status: "APPROVAL_EXPIRED", reason: "approval_expired", message: "expired" },
    };
    fireEvent.click(screen.getByRole("button", { name: "Approve" }));

    await waitFor(() => expect(screen.getByText(/Approval expired/)).toBeTruthy());
    expect(screen.getByText(/Submit the warehouse action again/)).toBeTruthy();
    expect(screen.queryByText(/Executing/)).toBeNull();
    // One decision, and no client-side reauthorisation attempt.
    expect(requests.filter((request) => request.url === "/api/agent/approve")).toHaveLength(1);
  });
});

describe("command centre — degraded services", () => {
  it("keeps the dashboard usable when the agent model is unavailable", async () => {
    overviewResponse = stockedOverview();
    agentResponse = {
      status: 503,
      body: { error: { code: "agent_model_unavailable", message: "unavailable" } },
    };
    await renderDashboard();
    await askAgent("Where is BRG-6204?");

    await waitFor(() => expect(screen.getByText(/Warehouse agent unavailable/)).toBeTruthy());
    // Everything that does not depend on the model still works.
    expect(within(panel("Inventory")).getByText("BRG-6204")).toBeTruthy();
    expect(within(panel("Digital warehouse")).getByText("OCCUPIED")).toBeTruthy();
    expect(within(panel("Recent movements")).getByText("COMPLETED")).toBeTruthy();
    expect(screen.getByText(/GANTRY MODE: SIMULATION/)).toBeTruthy();
  });

  it("keeps the dashboard usable when the camera cannot start", async () => {
    overviewResponse = stockedOverview();
    await renderDashboard();

    // jsdom exposes no mediaDevices, which is exactly the "no camera" case.
    fireEvent.click(screen.getByRole("button", { name: "Start camera" }));

    await waitFor(() => expect(screen.getByText("Camera unavailable")).toBeTruthy());
    expect(within(panel("Inventory")).getByText("BRG-6204")).toBeTruthy();
    expect(within(panel("Digital warehouse")).getByText("OCCUPIED")).toBeTruthy();
    expect(within(panel("Warehouse agent")).getByRole("button", { name: "Send" })).toBeTruthy();
  });

  it("keeps the last known warehouse state on screen when a refresh fails", async () => {
    overviewResponse = stockedOverview();
    await renderDashboard();
    await waitFor(() => expect(within(panel("Inventory")).getByText("BRG-6204")).toBeTruthy());

    (globalThis.fetch as ReturnType<typeof vi.fn>).mockImplementation(async (input: unknown) => {
      const url = String(input);
      if (url.startsWith("/api/gantry/status")) {
        return stubResponse({ status: 200, body: gantryResponse });
      }
      return stubResponse({ status: 500, body: {} });
    });
    await askAgent("Where is BRG-6204?");

    await waitFor(() => expect(screen.getAllByText(/Unable to load/).length).toBeGreaterThan(0));
    // Stale is stated; blank would claim the warehouse is empty.
    expect(within(panel("Inventory")).getByText("BRG-6204")).toBeTruthy();
  });
});

describe("command centre — Strands graph workflow", () => {
  const COMPLETED_WORKFLOW = {
    status: "COMPLETED",
    workflow: "PUTAWAY",
    operationId: "wf_putaway_scan_1",
    movementId: "m9",
    gantryOperationId: "gop_1",
    steps: [
      { nodeId: "putaway_validate", label: "Validate scan", status: "COMPLETED" },
      {
        nodeId: "putaway_identity",
        label: "Resolve identity",
        status: "COMPLETED",
        summary: "BRG-6204 — matched deterministically.",
      },
      { nodeId: "putaway_destination", label: "Resolve destination", status: "COMPLETED" },
      { nodeId: "putaway_preflight", label: "Preflight", status: "COMPLETED" },
      { nodeId: "putaway_execute", label: "Execute putaway", status: "COMPLETED" },
      { nodeId: "putaway_verify", label: "Verify", status: "COMPLETED" },
    ],
  };

  const BLOCKED_WORKFLOW = {
    status: "BLOCKED",
    workflow: "PUTAWAY",
    operationId: "wf_putaway_scan_2",
    reason: "catalog_match_ambiguous",
    message: "The catalog match is ambiguous, so putaway cannot proceed.",
    steps: [
      { nodeId: "putaway_validate", label: "Validate scan", status: "COMPLETED" },
      {
        nodeId: "putaway_identity",
        label: "Resolve identity",
        status: "BLOCKED",
        reason: "catalog_match_ambiguous",
      },
      { nodeId: "putaway_destination", label: "Resolve destination", status: "SKIPPED" },
      { nodeId: "putaway_preflight", label: "Preflight", status: "SKIPPED" },
      { nodeId: "putaway_execute", label: "Execute putaway", status: "SKIPPED" },
      { nodeId: "putaway_verify", label: "Verify", status: "SKIPPED" },
    ],
  };

  beforeEach(() => {
    overviewResponse = stockedOverview();
    agentResponse = { status: 200, body: RETRIEVAL_APPROVAL };
  });

  it("shows every graph stage after an approved action", async () => {
    await renderDashboard();
    await askAgent("Store this part.");
    await waitFor(() => expect(screen.getByRole("button", { name: "Approve" })).toBeTruthy());

    approveResponse = {
      status: 200,
      body: {
        status: "COMPLETED",
        message: "Stored.",
        toolCalls: ["execute_putaway"],
        workflows: [COMPLETED_WORKFLOW],
      },
    };
    fireEvent.click(screen.getByRole("button", { name: "Approve" }));

    await waitFor(() =>
      expect(screen.getByRole("heading", { name: "PUTAWAY workflow" })).toBeTruthy(),
    );
    const view = within(panel("PUTAWAY workflow"));
    for (const label of [
      "Validate scan",
      "Resolve identity",
      "Resolve destination",
      "Preflight",
      "Execute putaway",
      "Verify",
    ]) {
      expect(view.getByText(label)).toBeTruthy();
    }
    expect(view.getByText("BRG-6204 — matched deterministically.")).toBeTruthy();
    // Server-composed workflow state only — no tracing, no model internals.
    expect(view.queryByText(/token/i)).toBeNull();
  });

  it("shows where a blocked workflow stopped, and no success", async () => {
    await renderDashboard();
    await askAgent("Store this part.");
    await waitFor(() => expect(screen.getByRole("button", { name: "Approve" })).toBeTruthy());

    approveResponse = {
      status: 200,
      body: {
        status: "COMPLETED",
        message: "The catalog match is ambiguous.",
        toolCalls: ["execute_putaway"],
        workflows: [BLOCKED_WORKFLOW],
      },
    };
    fireEvent.click(screen.getByRole("button", { name: "Approve" }));

    await waitFor(() =>
      expect(screen.getByRole("heading", { name: "PUTAWAY workflow" })).toBeTruthy(),
    );
    const view = within(panel("PUTAWAY workflow"));
    // Twice: the workflow's overall status, and the stage that stopped it.
    expect(view.getAllByText("BLOCKED")).toHaveLength(2);
    expect(view.getByText("catalog_match_ambiguous")).toBeTruthy();
    expect(view.getAllByText("SKIPPED").length).toBe(4);
    // The stage that stopped it is never drawn as done.
    expect(view.queryByText(/Execute putaway/)?.closest("li")?.textContent).toContain("SKIPPED");
  });
});

describe("command centre — agent activity trace", () => {
  const TRACE = {
    traceId: "trace_1",
    status: "COMPLETED",
    requestSummary: "Bring me BRG-6204",
    startedAt: "2026-09-06T10:42:01.000Z",
    completedAt: "2026-09-06T10:42:06.000Z",
    durationMs: 5000,
    error: null,
    metrics: {
      modelCalls: 2,
      inputTokens: 800,
      outputTokens: 120,
      totalTokens: 920,
      modelLatencyMs: 1400,
    },
    events: [
      {
        sequence: 1,
        type: "AGENT_STARTED",
        category: "AGENT",
        status: "STARTED",
        name: "warehouse-agent",
        summary: "Warehouse request received.",
        startedAt: "2026-09-06T10:42:01.000Z",
        completedAt: null,
        durationMs: null,
        metadata: null,
      },
      {
        sequence: 2,
        type: "TOOL_COMPLETED",
        category: "TOOL",
        status: "COMPLETED",
        name: "search_inventory",
        summary: "BRG-6204 — 2 in stock, B2-01 (2)",
        startedAt: "2026-09-06T10:42:02.000Z",
        completedAt: "2026-09-06T10:42:02.084Z",
        durationMs: 84,
        metadata: { toolUseId: "tool-1", sku: "BRG-6204" },
      },
      {
        sequence: 3,
        type: "APPROVAL_APPROVED",
        category: "HUMAN",
        status: "COMPLETED",
        name: "execute_retrieval",
        summary: "Operator approved the action.",
        startedAt: null,
        completedAt: "2026-09-06T10:42:05.000Z",
        durationMs: 3000,
        metadata: { approvalId: "approval_1" },
      },
      {
        sequence: 4,
        type: "GANTRY_COMPLETED",
        category: "GANTRY",
        status: "COMPLETED",
        name: "RETRIEVAL",
        summary: "Gantry RETRIEVAL B2-01 → OUTPUT completed.",
        startedAt: null,
        completedAt: "2026-09-06T10:42:06.000Z",
        durationMs: 643,
        metadata: { gantryOperationId: "gantry_1" },
      },
      {
        sequence: 5,
        type: "INVENTORY_UPDATED",
        category: "WAREHOUSE",
        status: "COMPLETED",
        name: "BRG-6204",
        summary: "Inventory BRG-6204 in B2-01: -1, 1 remaining.",
        startedAt: null,
        completedAt: "2026-09-06T10:42:06.000Z",
        durationMs: null,
        metadata: { sku: "BRG-6204", delta: -1, remaining: 1 },
      },
    ],
  };

  beforeEach(() => {
    overviewResponse = stockedOverview();
    traceResponse = TRACE;
    agentResponse = {
      status: 200,
      body: {
        status: "COMPLETED",
        message: "Retrieved.",
        toolCalls: ["search_inventory"],
        traceId: "trace_1",
      },
    };
  });

  it("renders the timeline in order with categories, summaries and durations", async () => {
    await renderDashboard();
    await askAgent("Bring me BRG-6204.");

    await waitFor(() =>
      expect(within(panel("Agent activity")).getByText(/Warehouse request received/)).toBeTruthy(),
    );
    const view = within(panel("Agent activity"));

    expect(view.getByText("BRG-6204 — 2 in stock, B2-01 (2)")).toBeTruthy();
    expect(view.getByText("Operator approved the action.")).toBeTruthy();
    expect(view.getByText("Gantry RETRIEVAL B2-01 → OUTPUT completed.")).toBeTruthy();
    expect(view.getByText("Inventory BRG-6204 in B2-01: -1, 1 remaining.")).toBeTruthy();

    // Categories are words, not only colours.
    for (const label of ["AGENT", "TOOL", "HUMAN", "GANTRY", "WAREHOUSE"]) {
      expect(view.getAllByText(label).length).toBeGreaterThan(0);
    }
    expect(view.getByText("84 ms")).toBeTruthy();
    expect(view.getByText("643 ms")).toBeTruthy();

    // Metrics stay in a small technical footer, not in the operator flow.
    expect(view.getByText(/Model calls 2/)).toBeTruthy();
  });

  it("keeps detail collapsed and shows no model internals", async () => {
    await renderDashboard();
    await askAgent("Bring me BRG-6204.");
    await waitFor(() =>
      expect(within(panel("Agent activity")).getByText(/Warehouse request received/)).toBeTruthy(),
    );
    const view = within(panel("Agent activity"));

    // Not a JSON dump: detail is behind a click.
    expect(view.queryByText("tool-1")).toBeNull();
    fireEvent.click(view.getAllByRole("button", { name: "detail" })[0]);
    expect(view.getByText("tool-1")).toBeTruthy();

    const panelText = panel("Agent activity").textContent ?? "";
    for (const forbidden of ["systemPrompt", "thinking", "reasoning", "messages"]) {
      expect(panelText).not.toContain(forbidden);
    }
  });

  it("lists recent runs and lets an operator open one", async () => {
    recentTracesResponse = [
      {
        traceId: "trace_old",
        status: "DENIED",
        requestSummary: "Bring me BOLT-M8-50",
        startedAt: "2026-09-06T10:31:00.000Z",
        completedAt: "2026-09-06T10:31:04.000Z",
        durationMs: 4000,
        eventCount: 6,
      },
    ];
    await renderDashboard();
    await waitFor(() =>
      expect(within(panel("Agent activity")).getByRole("button", { name: "Recent runs" })).toBeTruthy(),
    );

    fireEvent.click(within(panel("Agent activity")).getByRole("button", { name: "Recent runs" }));
    const view = within(panel("Agent activity"));
    expect(view.getByText("Bring me BOLT-M8-50")).toBeTruthy();
    expect(view.getByText(/DENIED/)).toBeTruthy();

    fireEvent.click(view.getByRole("button", { name: /Bring me BOLT-M8-50/ }));
    await waitFor(() =>
      expect(requests.some((r) => r.url === "/api/observability/traces/trace_old")).toBe(true),
    );
  });
});

/* ------------------------------------------ scan identity, rendered directly */

const MEASUREMENT = {
  name: "ball bearing",
  description: "small steel ring",
  lengthMM: 47.2,
  widthMM: 46.9,
  heightMM: 14.1,
  angleDegrees: 12,
  dimensionConfidence: 0.96,
  calibrationRmsPixels: 1.4,
  measuredAt: 1_700_000_000_000,
};

function scanState(match: NonNullable<ScanState["scan"]>["match"]): ScanState {
  return {
    phase: "READY",
    failure: null,
    scan: {
      shotId: "shot_1",
      capturedAt: 1_700_000_000_000,
      measurement: MEASUREMENT,
      scanResult: {
        scanId: "scan_1",
        capturedAt: 1_700_000_000_000,
        object: { detectedName: "ball bearing", description: "small steel ring" },
        dimensions: { lengthMM: 47.2, widthMM: 46.9, heightMM: 14.1 },
        quality: { dimensionConfidence: 0.96, calibrationRmsPixels: 1.4 },
        orientation: { angleDegrees: 12 },
      },
      issues: [],
      match,
      matchError: null,
    },
  };
}

const EVIDENCE = {
  nameScore: 0.9,
  dimensionScore: 0.95,
  descriptionScore: 0.5,
  scanQualityScore: 0.9,
  planarDimensionErrorMM: 0.3,
  heightErrorMM: 0.1,
  matchedIdentifierTokens: ["6204"],
};

describe("current scan panel", () => {
  it("shows the SKU, name, dimensions and confidence of a matched scan", () => {
    render(
      <CurrentScanPanel
        state={scanState({
          status: "MATCHED",
          confidence: 0.97,
          matchedPart: {
            id: "p_brg",
            sku: "BRG-6204",
            canonicalName: "6204 Deep Groove Ball Bearing",
            category: "bearing",
          },
          evidence: EVIDENCE,
          alternatives: [],
        })}
        identity="MATCHED"
        confirmed={null}
      />,
    );

    expect(screen.getByText("MATCHED")).toBeTruthy();
    expect(screen.getByText("BRG-6204")).toBeTruthy();
    expect(screen.getByText("6204 Deep Groove Ball Bearing")).toBeTruthy();
    expect(screen.getByText("47.2")).toBeTruthy();
    expect(screen.getByText("46.9")).toBeTruthy();
    expect(screen.getByText("14.1")).toBeTruthy();
    expect(screen.getByText("97%")).toBeTruthy();
    expect(screen.getByText(/96%/)).toBeTruthy();
    expect(screen.getByText(/1.4 px/)).toBeTruthy();
  });

  it("does not present an ambiguous scan as identified", () => {
    render(
      <CurrentScanPanel
        state={scanState({
          status: "AMBIGUOUS",
          confidence: 0.62,
          reason: "Two catalog parts scored within 5% of each other.",
          candidates: [],
        })}
        identity="AMBIGUOUS"
        confirmed={null}
      />,
    );

    expect(screen.getByText("AMBIGUOUS")).toBeTruthy();
    expect(screen.queryByText("MATCHED")).toBeNull();
    expect(screen.getByText(/An operator must decide/)).toBeTruthy();
  });

  it("states a no-match clearly and offers no putaway success", () => {
    render(
      <CurrentScanPanel
        state={scanState({
          status: "NO_MATCH",
          confidence: 0.1,
          reason: "No catalog part scored above the matching threshold.",
          candidates: [],
        })}
        identity="NO_MATCH"
        confirmed={null}
      />,
    );

    expect(screen.getByText("NO MATCH")).toBeTruthy();
    expect(screen.getByText(/Putaway is on hold/)).toBeTruthy();
    expect(screen.queryByText(/stored/i)).toBeNull();
  });

  it("marks an unusable measurement as an invalid scan and asks for a rescan", () => {
    const state = scanState(null);
    state.scan!.scanResult = null;
    state.scan!.issues = ["dimensions.lengthMM must be a finite number greater than 0"];

    render(<CurrentScanPanel state={state} identity="INVALID_SCAN" confirmed={null} />);

    expect(screen.getByText("INVALID SCAN")).toBeTruthy();
    expect(screen.getByText(/Scan the part again/)).toBeTruthy();
    expect(
      screen.getByText("dimensions.lengthMM must be a finite number greater than 0"),
    ).toBeTruthy();
  });

  it("reports a human-confirmed identity as human, never as matched", () => {
    render(
      <CurrentScanPanel
        state={scanState({
          status: "AMBIGUOUS",
          confidence: 0.62,
          reason: "Two catalog parts scored within 5% of each other.",
          candidates: [],
        })}
        identity="HUMAN_CONFIRMED"
        confirmed={{
          resolutionId: "res_1",
          scanId: "scan_1",
          partId: "p_brg",
          sku: "BRG-6204",
          canonicalName: "6204 Deep Groove Ball Bearing",
        }}
      />,
    );

    expect(screen.getByText("HUMAN CONFIRMED")).toBeTruthy();
    expect(screen.queryByText("MATCHED")).toBeNull();
    expect(screen.getByText(/Identified by an operator, not by the matcher/)).toBeTruthy();
    expect(screen.getByText(/still reports AMBIGUOUS/)).toBeTruthy();
  });
});

describe("catalog resolution card", () => {
  const IDENTIFICATION = {
    resolutionId: "res_1",
    scanId: "scan_1",
    reason: "Two catalog parts scored within 5% of each other.",
    expiresAt: new Date(Date.now() + 300_000).toISOString(),
    candidates: [
      {
        partId: "p_a",
        sku: "BRG-6204",
        canonicalName: "6204 Deep Groove Ball Bearing",
        confidence: 0.79,
        dimensions: { lengthMM: 47, widthMM: 47, heightMM: 14 },
        evidence: EVIDENCE,
        imageUrl: null,
      },
      {
        partId: "p_b",
        sku: "BRG-6205",
        canonicalName: "6205 Deep Groove Ball Bearing",
        confidence: 0.75,
        dimensions: { lengthMM: 52, widthMM: 52, heightMM: 15 },
        evidence: EVIDENCE,
        imageUrl: null,
      },
    ],
  };

  it("offers only the candidates the server listed, with their evidence", () => {
    const onSelect = vi.fn();
    render(
      <CatalogResolutionCard
        identification={IDENTIFICATION}
        confirmed={null}
        rejected={false}
        busy={false}
        error={null}
        detectedName={null}
        onSelect={onSelect}
        onReject={() => {}}
        onRegisterNewPart={() => {}}
        registeringPart={false}
        registerError={null}
      />,
    );

    expect(screen.getByText(/Human decision required/)).toBeTruthy();
    expect(screen.getByText("6204 Deep Groove Ball Bearing")).toBeTruthy();
    expect(screen.getByText("79%")).toBeTruthy();
    expect(screen.getByText("6205 Deep Groove Ball Bearing")).toBeTruthy();
    expect(screen.getByRole("button", { name: "None of these" })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: /Select BRG-6205/ }));
    expect(onSelect).toHaveBeenCalledWith("p_b");
  });

  it("surfaces a server refusal instead of recording the choice locally", () => {
    render(
      <CatalogResolutionCard
        identification={IDENTIFICATION}
        confirmed={null}
        rejected={false}
        busy={false}
        error="That part was not offered as a candidate for this scan."
        detectedName={null}
        onSelect={() => {}}
        onReject={() => {}}
        onRegisterNewPart={() => {}}
        registeringPart={false}
        registerError={null}
      />,
    );

    expect(
      screen.getByText("That part was not offered as a candidate for this scan."),
    ).toBeTruthy();
    // Still pending: nothing was confirmed on the strength of a click.
    expect(screen.getByRole("button", { name: /Select BRG-6204/ })).toBeTruthy();
  });

  it("preserves provenance once an identity is confirmed", () => {
    render(
      <CatalogResolutionCard
        identification={null}
        confirmed={{
          resolutionId: "res_1",
          scanId: "scan_1",
          partId: "p_a",
          sku: "BRG-6204",
          canonicalName: "6204 Deep Groove Ball Bearing",
        }}
        rejected={false}
        busy={false}
        error={null}
        detectedName={null}
        onSelect={() => {}}
        onReject={() => {}}
        onRegisterNewPart={() => {}}
        registeringPart={false}
        registerError={null}
      />,
    );

    expect(screen.getByText(/Identity confirmed/)).toBeTruthy();
    expect(screen.getByText(/Human verified/)).toBeTruthy();
    expect(screen.queryByText("MATCHED")).toBeNull();
  });

  it("offers a clear way to register a new part once every candidate is rejected", () => {
    const onRegisterNewPart = vi.fn();
    render(
      <CatalogResolutionCard
        identification={null}
        confirmed={null}
        rejected={true}
        busy={false}
        error={null}
        detectedName="Brass male-female standoff"
        onSelect={() => {}}
        onReject={() => {}}
        onRegisterNewPart={onRegisterNewPart}
        registeringPart={false}
        registerError={null}
      />,
    );

    expect(screen.getByText("Brass male-female standoff")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Register as new catalog part" }));
    expect(onRegisterNewPart).toHaveBeenCalledTimes(1);
  });
});
