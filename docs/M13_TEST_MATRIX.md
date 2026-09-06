# Milestone 13 — Software Freeze Validation Matrix

Integration behaviour and safety invariants only. Unit-level coverage
(scoring, normalization, rotation, validation) is not repeated here — it lives
in the suite and is listed at the bottom as a count.

Automated rows run in `tests/m13-freeze.test.ts` unless another file is named.
Live rows were executed against the dev server on real Amazon Bedrock, from a
`npm run demo:reset` state, with no manual database editing.

Legend — **A** automated, **L** live/manual, **PASS** verified this milestone.

---

## Scenario A — known-part putaway

| ID | Scenario | Expected | Kind | Result |
|----|----------|----------|------|--------|
| E2E-01 | Agent → HITL → approve → graph → gantry → commit | 1 gantry op, 1 inventory +1, 1 COMPLETED Movement, bin OCCUPIED | A | PASS |
| E2E-01a | State before approval | no gantry op, no inventory, no Movement, bin AVAILABLE | A | PASS |
| E2E-01b | Putaway into a warehouse that already holds the SKU | next AVAILABLE bin chosen, one-SKU-per-bin preserved | A | PASS |
| E2E-01L | Same flow over HTTP on real Bedrock | BRG-6204 → A01, 22-event trace, one timeline across the pause | L | PASS |

## Scenario B — retrieval

| ID | Scenario | Expected | Kind | Result |
|----|----------|----------|------|--------|
| E2E-02 | Retrieval with quantity 2 in the source bin | 2 → 1, bin stays OCCUPIED | A | PASS |
| E2E-02b | Retrieval of the last item | 1 → 0, bin becomes AVAILABLE | A | PASS |
| E2E-02c | Putaway then retrieval | warehouse returns to empty, bin AVAILABLE | A | PASS |
| E2E-02L | Same flow over HTTP on real Bedrock | model resolved A01 via `search_inventory`, approved, 1 → 0 | L | PASS |

## Scenario C — ambiguous scan and human resolution

| ID | Scenario | Expected | Kind | Result |
|----|----------|----------|------|--------|
| E2E-03 | Ambiguous → candidates → confirm → approve → putaway | identity first, approval second, movement third | A | PASS |
| E2E-03a | Before identity resolution | no gantry, no inventory | A | PASS |
| E2E-03b | After candidate selection, before action approval | still no gantry, still no inventory | A | PASS |
| E2E-03c | Identity provenance | `identity.source = HUMAN_RESOLUTION`; matcher verdict stays `AMBIGUOUS` | A | PASS |
| E2E-03d | Confirm a Part that was not offered | `candidate_not_allowed`, no mutation | A | PASS |
| E2E-03e | Replay a resolution against a different `scanId` | `catalog_resolution_invalid`, no mutation | A | PASS |
| E2E-03f | Human override of an unusable scan | `RESCAN_REQUIRED` / `invalid_scan`, never a movement | A | PASS |
| E2E-03L | Same flow over HTTP on real Bedrock | AMBIGUOUS 0.926 vs 0.900, confirmed BOLT-M8-50 → B02 | L | PASS |

## Scenario D — failure, denial, recovery

| ID | Scenario | Expected | Kind | Result |
|----|----------|----------|------|--------|
| D1 | Denied putaway | no gantry op, no inventory, no Movement, trace `DENIED` | A + L | PASS |
| D2 | Denied retrieval | no gantry op, stock unchanged, bin unchanged | A + L | PASS |
| D3 | Approval expires before a decision | `approval_expired`, audit row `EXPIRED`, no mutation | A | PASS |
| D4 | Putaway pickup failure | Movement FAILED, GantryOperation FAILED, inventory unchanged, reservation released | A | PASS |
| D4b | Retry the same scan after a failure | permitted — the idempotency claim was released | A | PASS |
| D5 | Retrieval pickup failure | Movement FAILED, stock unchanged, source bin still OCCUPIED | A | PASS |
| D6 | Second operation while the gantry is busy | `gantry_busy`, no mutation, no reservation left behind | A | PASS |
| D7 | No AVAILABLE bin | `no_available_bin` before any physical execution | A | PASS |
| D8 | Retrieval of a known part with zero stock | `out_of_stock`, no gantry | A + L | PASS |
| D9 | Retrieval of an unknown SKU | `part_not_found` — never reported as zero stock | A + L | PASS |
| D10 | Structurally invalid scan | `invalid_scan`, no resolution offered, no putaway | A | PASS |
| D11 | `NO_MATCH` | putaway blocked, no Part invented, no gantry | A + L | PASS |
| D12 | Stale approval — bin disabled after the card was raised | revalidated and refused; approval authorises the action, not the outcome | A | PASS |
| D13 | Commit fails after the gantry succeeded | `putaway_commit_failed` / `retrieval_commit_failed`, ids preserved, **no second gantry run** | A (`putaway-service`, `retrieval-service`) | PASS |
| D14 | Same `scanId` submitted twice | one gantry op, one increment, second call `duplicate: true` | A + L | PASS |
| D14b | Approving the same card twice | second attempt `approval_not_pending`, one increment | A | PASS |
| D15 | Same retrieval `requestId` twice | one gantry op, one decrement | A | PASS |
| D16 | Two putaways racing for one AVAILABLE bin | exactly one reserves; the other fails safely | A | PASS |
| D17 | Two retrievals racing for the last item | exactly one succeeds; quantity never negative | A | PASS |
| D18 | Trace persistence broken mid-operation | putaway still correct; one gantry op; no retry | A | PASS |
| D19 | Model unavailable | `agent_model_unavailable`; warehouse data unchanged and still readable | A | PASS |
| D20 | No scan attached (camera failure) | refused; nothing invented, nothing moved | A | PASS |
| D21 | A write tool fails outright | trace `FAILED`, not `COMPLETED`; nothing moved | A | PASS |
| D21a | A read-only tool fails and is retried successfully | trace `COMPLETED` — a recovered failure is not a failed run | A | PASS |
| D21c | A workflow is blocked by a business rule | trace `BLOCKED`, distinct from `FAILED` | A | PASS |
| D22 | Application restart | DB facts persist; simulator history and parked approvals do not | A | PASS |
| D23 | Raw gantry movement endpoints outside development | `gantry_dev_only` (403); read-only status never gated | A | PASS |

## Tampering — the client is never trusted

| ID | Scenario | Expected | Kind | Result |
|----|----------|----------|------|--------|
| T1 | Redirect an approval to a different bin | impossible — the approve API takes an id and a decision only | A | PASS |
| T2 | Re-use a DENIED approval to approve | `approval_not_pending`, no mutation | A + L | PASS |
| T3 | Unknown approval id | `approval_not_found` | A | PASS |
| T4 | Fabricated part id | `part_not_found` | A | PASS |
| T5 | Explicitly requested unavailable destination | `bin_unavailable` | A | PASS |
| T6 | Prompt injection in `ScanResult.description` | treated as data; no capability granted; nothing moved | A | PASS |
| T7 | Scan text in the system prompt | never — asserted in `warehouse-agent.test.ts` | A | PASS |
| T8 | `POST`/`DELETE` an observability route | 405; the API is read-only | L | PASS |

## Database invariants

Asserted by `assertWarehouseInvariants()` at the end of **every** scenario
above, so no path may leave the warehouse in a state it cannot explain.

| # | Invariant |
|---|-----------|
| 1 | `Inventory.quantity >= 0` for every row |
| 2 | At most one SKU per bin |
| 3 | An `AVAILABLE` bin holds no stock; an `OCCUPIED` bin holds exactly one stocked row |
| 4 | A `RESERVED` bin always has a live Movement that owns the reservation |
| 5 | A `COMPLETED` Movement carries a `gantryOperationId` and a `completedAt` |
| 6 | A `FAILED` Movement holds no idempotency claim, so the operator may retry |

## Coverage summary

| Layer | File | Tests |
|-------|------|-------|
| Freeze / end-to-end | `tests/m13-freeze.test.ts` | 45 |
| Agent, prompt, errors | `tests/warehouse-agent.test.ts` | 48 |
| Tools and allowlist | `tests/warehouse-tools.test.ts` | 41 |
| Simulator | `tests/gantry-simulator.test.ts` | 33 |
| Warehouse services | `tests/warehouse-service.test.ts` | 33 |
| Catalog matcher | `tests/catalog-matcher.test.ts` | 30 |
| Strands graphs | `tests/warehouse-graphs.test.ts` | 30 |
| Dashboard components | `tests/command-center.test.tsx` | 28 |
| Observability | `tests/observability.test.ts` | 23 |
| Retrieval service | `tests/retrieval-service.test.ts` | 19 |
| Putaway service | `tests/putaway-service.test.ts` | 18 |
| HITL approvals | `tests/hitl-approval.test.ts` | 18 |
| Catalog resolution | `tests/catalog-resolution.test.ts` | 17 |
| Dashboard read model | `tests/warehouse-dashboard.test.ts` | 14 |
| Agent loop | `tests/warehouse-agent-loop.test.ts` | 5 |
| Seed | `tests/warehouse-seed.test.ts` | 3 |
| **Total** | **16 files** | **405** |
