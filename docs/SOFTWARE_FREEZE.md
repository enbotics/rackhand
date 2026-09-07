# Software Freeze — Milestone 13

**Freeze date:** 2026-09-06
**Status:** application architecture frozen until real-hardware integration.
**Next change permitted:** the gantry layer only (Milestones 14–15).

After this point: no refactoring for aesthetics, no renaming APIs, no swapping
libraries, no moving business logic between layers, no new abstraction layers.
The `GantryController` interface below is the contract `RealGantryController`
must satisfy, and it does not change casually.

---

## 1. Frozen runtime and dependencies

| Component | Version |
|-----------|---------|
| Node | 22.22.1 |
| npm | 10.9.4 |
| Next.js | 16.3.4 (App Router, Turbopack) |
| React / React DOM | 19.2.8 |
| `@strands-agents/sdk` | 1.16.0 |
| Prisma / `@prisma/client` | 7.10.0 |
| `@prisma/adapter-better-sqlite3` | 7.10.0 |
| `better-sqlite3` | 12.11.1 |
| `zedbar` (QR detection) | 0.5.1 |
| `zod` | 4.5.4 |
| TypeScript | 5.x |
| Vitest | 3.2.7 |

**Database:** SQLite, local file, via the Prisma driver adapter.
**Gantry mode:** `SIMULATION` — no hardware controller exists.
**Model providers:** Amazon Bedrock (`us.amazon.nova-lite-v1:0`) for the
Warehouse Agent; Google Gemini for vision measurement. They are deliberately
separate models.

> The code default is `global.anthropic.claude-sonnet-5`; `.env` overrides it
> with Nova because this account's AWS Marketplace subscription for Anthropic
> models is blocked (`INVALID_PAYMENT_INSTRUMENT`). Switching back is one line
> in `.env` — no code change.

Do not upgrade Next, React, Prisma, the Strands SDK or the Node runtime during
the freeze.

---

## 2. Pages

Four routes, grouped by what the operator is doing. The menu is in the shared
layout, so `GANTRY MODE: SIMULATION` is pinned on every page.

| Route | Page | Panels |
|-------|------|--------|
| `/` | **Operate** | Live camera · Current scan · Human decisions (approval + identity) · Warehouse agent · Workflow |
| `/warehouse` | **Warehouse** | Digital warehouse · Inventory · Gantry |
| `/history` | **History** | Recent movements (authoritative) · Recent scans (local IndexedDB) |
| `/activity` | **Activity** | Agent activity trace timeline · Recent runs |

The **live loop stays on `/`** — scan, identify, ask, approve — because
Milestone 13 validated that sequence without navigation. The bin map is on
Warehouse only; what Operate needs after an action is whether it happened, and
the approval outcome (read back from the Movement row) and the Workflow panel
both name the destination bin.

Session state (current scan, pending approval, agent turns, followed trace)
lives in `WarehouseSessionProvider` **above** the router outlet, so moving
between pages never destroys a decision the server is still holding open. The
polling hooks run once there rather than once per page.

## 3. Architecture (frozen)

```
UGREEN CAMERA → Gemini → ScanResult → Catalog Matcher
                                            │
                                  STRANDS WAREHOUSE AGENT
                                            │
                        ┌───────────────────┼───────────────────┐
                   read-only tools    execute_putaway     execute_retrieval
                    (no approval)            │                   │
                                             └──── STRANDS HITL ──┘
                                                  APPROVE / DENY
                                                        │
                                                 STRANDS GRAPH
                                                        │
                                             Deterministic Services
                                                  │           │
                                          Warehouse DB   GantryController
                                                              │
                                                          SIMULATOR
```

Observability wraps this flow and never controls it.

---

## 4. GantryController contract (the M15 hardware boundary)

`src/lib/gantry/controller.ts`. Warehouse-level intent only — never axes,
steps or motor positions.

```ts
interface GantryController {
  getStatus(): Promise<GantryStatus>;              // never throws
  home(): Promise<GantryOperation>;                // establish the reference position
  putaway(input: PutawayRequest): Promise<GantryOperation>;    // INTAKE → bin
  retrieve(input: RetrievalRequest): Promise<GantryOperation>; // bin → OUTPUT
  getRecentOperations(limit?: number): Promise<GantryOperation[]>;
}

interface PutawayRequest   { source: "INTAKE";        destination: WarehouseBinCode }
interface RetrievalRequest { source: WarehouseBinCode; destination: "OUTPUT" }

interface GantryStatus {
  mode: "SIMULATION" | "HARDWARE";
  state: "OFFLINE" | "IDLE" | "HOMING" | "MOVING" | "PICKING" | "DROPPING" | "ERROR";
  currentLocation: GantryLocation | null;   // null = home / not yet homed
  homed: boolean;
  activeOperationId: string | null;
  lastError: string | null;                 // cleared by the next success
}

interface GantryOperation {
  operationId: string;
  type: "HOME" | "PUTAWAY" | "RETRIEVAL";
  source: GantryLocation | null;
  destination: GantryLocation | null;
  status: "PENDING" | "RUNNING" | "COMPLETED" | "FAILED" | "CANCELLED";
  startedAt: number | null;
  completedAt: number | null;
  error: string | null;   // a GantryFailureKind when FAILED
}
```

**Locations — the physical shelf.** The rack has two bays. One is the
**workstation**: the camera scans a part there, and it is where every part
arrives from and leaves to. That bay is `INTAKE` and `OUTPUT`, deliberately
**not** `Bin` rows — bin-availability logic must never see the scan table as
somewhere stock can live.

The other bay is **storage**: six beds (shelf levels), five bin-box slots
across each, thirty in all. A bin box is 4" wide × 12" deep, so one slot is one
box-width along a bed.

```
bed 6   B6-01  B6-02  B6-03  B6-04  B6-05
bed 5   B5-01  B5-02  B5-03  B5-04  B5-05
bed 4   B4-01  B4-02  B4-03  B4-04  B4-05
bed 3   B3-01  B3-02  B3-03  B3-04  B3-05
bed 2   B2-01  B2-02  B2-03  B2-04  B2-05
bed 1   B1-01  B1-02  B1-03  B1-04  B1-05     <- bottom of the rack
```

**The code is the position.** `B4-02` is bed 4, slot 2, so an M15 coordinate is
a parse (`parseBinCode`) rather than a hand-maintained lookup: bed selects the
vertical axis, slot the horizontal one. Codes sort into physical order, so the
deterministic "lowest available bin" policy fills bed 1 left-to-right before
climbing. `STORAGE_BEDS` and `SLOTS_PER_BED` in `src/lib/warehouse/types.ts`
are the only two numbers to change if the shelf grows.

**Error semantics — the rule a hardware adapter must follow.**

* A rejected *request* **throws** `GantryError`: `invalid_request`,
  `invalid_location`, `gantry_busy`, `gantry_mode_unsupported`.
* An operation that started and then failed **does not throw**. It returns a
  `GantryOperation` with `status: "FAILED"` and an `error` naming the failure
  kind: `pickup_failed`, `drop_failed`, `movement_timeout`, `controller_error`.
* One operation at a time. The controller's own synchronous claim is the
  authoritative mutex; the services' pre-check is advisory.
* The controller reports machine outcomes. It never touches inventory, bins or
  Movements, and it never decides what the warehouse believes.

**Expected hardware semantics.** `putaway` moves INTAKE → bin; `retrieve` moves
bin → OUTPUT; success is `COMPLETED`; failure is `FAILED` plus a machine error.
No raw motor positions may surface in the agent or domain layers.

---

## 5. Strands tool allowlist (frozen)

Seven read-only tools, approval-free:

`get_gantry_status` · `search_catalog` · `get_part` · `search_inventory` ·
`get_bin_status` · `list_available_bins` · `match_catalog`

Two write tools, approval **always** required:

`execute_putaway` · `execute_retrieval`

The agent has **no** shell, filesystem, generic HTTP, code execution, browser,
raw Prisma, arbitrary query, raw gantry, or direct inventory/bin mutation tool,
and no Strands vended tool is imported anywhere in the subsystem. There is no
`create_part`, `reserve_bin`, `add_inventory` or `gantry_putaway`. Asserted in
`tests/warehouse-tools.test.ts`.

**HITL policy.** Approval-free is an explicit allowlist; anything absent from
it requires approval, so a tool added later is gated by default. An approval
binds to one interrupt with frozen arguments — the client sends only an id and
APPROVE/DENY, and can never restate the call.

## 6. Graphs (frozen)

| Graph | Nodes | Config |
|-------|-------|--------|
| Putaway | 6: validate → identity → destination → preflight → execute → verify | `maxSteps: 12`, `timeout: 60_000`, `maxConcurrency: 1` |
| Retrieval | 7: validate → identity → stock → source → preflight → execute → verify | `maxSteps: 14`, `timeout: 60_000`, `maxConcurrency: 1` |

Linear and acyclic, so a physical action can never be repeated by a loop. Every
node is deterministic code — no agent or model node. Only the execute node
calls a service.

## 7. Source-of-truth rules (frozen)

| Concern | Authority |
|---------|-----------|
| Catalog, inventory, bins, Movements | **Warehouse database** |
| Machine operation result | **GantryController** |
| What the camera observed | **ScanResult** (an observation, not identity) |
| Machine identity confidence | **Catalog Matcher** — `MATCHED` / `AMBIGUOUS` / `NO_MATCH` |
| Operator identity override | **CatalogResolution** — separate provenance, never rewrites the matcher |
| Traces, timelines, metrics | **Observability — not authoritative** |
| Agent chat history | **Never warehouse truth** |

Browser IndexedDB holds local scan history only; the warehouse database is
authoritative for inventory.

## 8. Error codes (frozen — do not rename)

**Scan / measurement:** `mat_not_detected` · `calibration_failed` ·
`no_object_detected` · `multiple_objects`

**Catalog:** `catalog_match_ambiguous` · `catalog_no_match` ·
`catalog_resolution_invalid` · `candidate_not_allowed` · `resolution_not_found` ·
`resolution_not_pending` · `resolution_expired`

**Putaway:** `invalid_scan` · `part_not_found` · `no_available_bin` ·
`bin_not_found` · `bin_unavailable` · `bin_reservation_conflict` ·
`gantry_busy` · `gantry_failed` · `putaway_commit_failed` · `putaway_in_progress`

**Retrieval:** `invalid_request` · `unsupported_quantity` · `part_not_found` ·
`out_of_stock` · `source_bin_not_found` · `source_inventory_mismatch` ·
`inventory_conflict` · `gantry_busy` · `gantry_failed` ·
`retrieval_commit_failed` · `retrieval_in_progress`

**Approvals:** `approval_not_found` · `approval_expired` · `approval_not_pending`

**Gantry (request-level, thrown):** `invalid_request` · `invalid_location` ·
`gantry_busy` · `gantry_mode_unsupported` · `gantry_dev_only`

**Agent:** `agent_invalid_request` · `agent_model_unavailable` ·
`agent_invocation_failed` · `tool_execution_failed`

**Warehouse (HTTP):** `validation_failed` · `invalid_quantity` ·
`part_not_found` · `bin_not_found` · `inventory_not_found` ·
`movement_not_found` · `duplicate_sku` · `duplicate_bin_code` ·
`bin_unavailable` · `bin_capacity_exceeded` · `inventory_conflict` ·
`insufficient_inventory` · `invalid_status_transition` · `internal_error`

## 9. Recovery behaviour

| Failure | Can the operator retry? | How |
|---------|------------------------|-----|
| Invalid scan | Yes | Rescan. Nothing was claimed. |
| `NO_MATCH` | No, not as-is | The part must be added to the catalog first. Nothing is invented. |
| `AMBIGUOUS` | Yes | Resolve identity, then request the action. Two separate decisions. |
| Approval denied | Yes | A **new explicit request**. A denial never reopens, and the model may not re-ask. |
| Approval expired | Yes | Ask again. Nothing was performed. |
| Gantry failure before commit | Yes | State is unchanged, the bin is released and the idempotency claim is cleared. |
| `gantry_busy` | Yes | Wait for the current operation. |
| `no_available_bin` | Yes | Free a bin first. |
| **Commit failure after the gantry succeeded** | **No — manual reconciliation** | The part HAS moved. `putaway_commit_failed` / `retrieval_commit_failed` are returned with `movementId` and `gantryOperationId`; the Movement stays `RUNNING`. **A physical retry is unsafe and is never attempted automatically.** |

There is no `catch → execute again` anywhere, and no graph edge loops back to
an execute node.

## 10. Environment

See `.env.example`. `.env` is committed and holds non-secret configuration
only; `.env.local` is git-ignored and holds every credential.

| Variable | Where | Purpose |
|----------|-------|---------|
| `DATABASE_URL` | `.env` | SQLite file path |
| `GANTRY_MODE` | `.env` | `simulation` (only implemented mode) |
| `GANTRY_SIM_*_DELAY_MS` | optional | simulator pacing |
| `AWS_REGION` | `.env` | Bedrock region |
| `BEDROCK_MODEL_ID` | `.env` | inference-profile model id |
| `AWS_BEARER_TOKEN_BEDROCK` *or* `AWS_ACCESS_KEY_ID`/`AWS_SECRET_ACCESS_KEY` | **`.env.local`** | Bedrock credential |
| `GEMINI_API_KEY` | **`.env.local`** | vision pipeline |

**Secret scan:** no credential appears in tracked source or anywhere in git
history. `.env.local` is ignored; the only key-shaped strings in the repo are
AWS's published documentation example (`AKIAIOSFODNN7EXAMPLE`) used as a
redaction-test fixture.

## 11. Commands

```bash
npm run demo:reset    # empty the warehouse (development only, never an API)
npm run demo:stock    # place the deterministic sample stock layout
npm run db:seed       # idempotent catalog + bins
npm run test:smoke    # offline stack check, no model calls
npm test              # full suite — no Bedrock or Gemini required
npm run test:live     # REAL Bedrock calls, costs money
npm run build
npm run lint
npx prisma validate
```

**Demo reset state:** catalog `BRG-6204 · BRG-6205 · BOLT-M8-50 ·
BOLT-M8-50-FLG · BOLT-M10-60`; all thirty bins `B1-01`–`B6-05` `AVAILABLE`;
inventory empty; no approvals, resolutions or traces; gantry `SIMULATION`,
`IDLE` after a dev-server restart.

**Sample stock (`demo:stock`)** places a starting position in which every demo
path is reachable. Stock goes in through the inventory SERVICE, so it obeys
one-SKU-per-bin, capacity and bin-status rules; no gantry runs and no Movements
are created, because this is a starting position and not a history.

| Bin | Holds | Why |
|-----|-------|-----|
| B1-01 | `BRG-6204` × 2 | retrieval leaves the bin `OCCUPIED` |
| B1-02 | `BOLT-M8-50` × 1 | retrieval empties it, so the bin frees itself |
| B2-03 | `BRG-6204` × 1 | same part on a **different bed**, so Inventory shows `B1-01 (2), B2-03 (1)` and the gantry has to change height |
| B3-05 | `BOLT-M10-60` × 4 | a larger holding, far corner of the shelf |
| the other 26 slots | — | `AVAILABLE`, so a putaway always has somewhere to go |

`BRG-6205` and `BOLT-M8-50-FLG` stay in the catalog with no stock, which is
what makes `out_of_stock` demonstrable and distinguishable from
`part_not_found` for a SKU like `BRG-9999`. Re-running `demo:stock` refuses
bins that already hold stock rather than doubling a holding.

`demo:reset` refuses to run with `NODE_ENV=production` or against a
non-`file:` database. The test suite refuses any `DATABASE_URL` whose path
does not contain `test-warehouse`.

## 12. Restart behaviour

**Persists** (SQLite): catalog, inventory, bin state, Movements, approval
audit rows, catalog resolutions, traces.

**Does not persist** (process-local, by design): the gantry simulator's state
and operation history, and parked Strands approval snapshots.

A restart therefore returns the machine to `IDLE` with an empty history, and
any approval that was awaiting a decision resolves as `approval_expired` on the
next attempt — the audit row is marked `EXPIRED` and nothing executes. A
snapshot that outlived its process could otherwise run a stale plan against a
warehouse that has moved on.

## 13. Known limitations (accepted for the MVP)

* SQLite, local only. No distributed locking; concurrency safety comes from
  single-writer SQLite plus conditional updates and unique constraints.
* Simulator and parked approvals are process-local.
* One SKU per bin; one physical item per operation.
* No automated reconciliation after a post-motion DB failure — reported, never
  silently retried.
* No production auth or RBAC. The dashboard assumes a trusted local operator.
* No real gantry.
* Trace retention is manual (`pruneTraces`); no scheduler.
* The observability APIs are read-only and offer no replay control by design.
* Running Nova rather than Claude, pending the Marketplace subscription.

## 14. Freeze checklist

| # | Gate | Result |
|---|------|--------|
| 1 | Production build succeeds | PASS |
| 2 | Full test suite passes | PASS — 405 tests, 16 files |
| 3 | Lint clean | PASS — 0 errors, 1 pre-existing unrelated warning |
| 4 | Prisma schema validates | PASS |
| 5 | Migrations apply to an empty database | PASS — the test suite builds its DB from them every run |
| 6 | Inventory cannot go negative | PASS |
| 7 | No write tool bypasses HITL | PASS |
| 8 | `AMBIGUOUS` never auto-executes | PASS |
| 9 | `NO_MATCH` creates no Part or Inventory | PASS |
| 10 | Gantry failure never increments inventory | PASS |
| 11 | Retrieval failure never decrements inventory | PASS |
| 12 | Duplicate requests are idempotent | PASS |
| 13 | Concurrency preserves bin and stock integrity | PASS |
| 14 | Approval replay executes nothing | PASS |
| 15 | Traces leak no credentials, images or reasoning | PASS |
| 16 | The dashboard never shows success for a failed backend | PASS — fixed this milestone |
| 17 | Graphs never auto-retry a physical action | PASS — acyclic, asserted |
| 18 | The agent has no raw shell, DB or gantry access | PASS |
| 19 | No credentials in source or git history | PASS |
| 20 | `GANTRY MODE: SIMULATION` is displayed | PASS |

**Recommendation: READY FOR GANTRY ASSEMBLY.**
