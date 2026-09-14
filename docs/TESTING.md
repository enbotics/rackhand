# RackHand application testing

[Open the HTML guide](../public/testing.html), or visit `/testing.html` on the running application.

Use this guide to test the browser experience, production camera/scale
verification, and automated checks. Steps below are test procedures and
expected results, not a claim that a live hardware test has already passed.

## Quick browser walkthrough

The public workspace is locked to **Simulation**. Prod mode cannot be enabled
because it can trigger real hardware. Only **B1-01** and **B1-02** may move.
Physical tests below are reference procedures and are unavailable in this build.

1. Open the **Workspace** at `/` and confirm **GANTRY MODE: SIMULATION** in the header.
2. Confirm the floating simulation dialog opens automatically, explains the lock, and shows both bins and suggested prompts. Dismiss it with **Got it**; use **Simulation · Locked** to reopen it.
3. Enter **Bring me bin B1-01**, approve the request in chat, and follow the simulation comparison.
4. Enter **Return bin B1-01 to its shelf**, then approve the return.
5. Repeat with **Bring me bin B1-02** and **Return bin B1-02 to its shelf**.
6. Request **Bring me bin B3-03**. Expect an explanation that only B1-01 and B1-02 may move, without a mode-switch suggestion or movement.
7. Open **History** and **Activity** to inspect the results.

Both allowed bins must be stocked. B1-01 uses curated photos; B1-02 uses a
labeled illustration of recorded inventory. Parts without a configured item
weight keep their recorded quantity. No weight or physical quantity is inferred
from these illustrations. The earlier three-bin control-module scenario is
unavailable under this lock.

## Prepare the application

For a new checkout, follow [Running locally](../README.md#running-locally).
Use Node.js 22.12+ in the 22.x series, or Node.js 24.x, and configure a dedicated
development/demo database. Browser workflows update that database.

The application needs PostgreSQL/Supabase and accessible Bedrock credentials.
Production image inspection also needs `GEMINI_API_KEY` and an authenticated
Pi worker. The explicit browser scenario supplies its own inspection evidence.

In the application's `.env.local`, set:

```env
GANTRY_MODE=simulation
AUDIT_CAPTURE_MODE=SIMULATION
PUTAWAY_CONTAINER_TARE_GRAMS=107
```

Keep the existing database/provider credentials. If setting up a new database,
apply migrations and seed using the README instructions. Seeding creates bins
and example catalog entries; it does not prepare the complete stocked demo.

Start the application:

```bash
npm run dev
```

Open [http://localhost:3000](http://localhost:3000). Confirm that Workspace,
Scan, History, and Activity open without a loading or connection error.
The mode badge opens the simulation guide; it cannot change capture mode.
Gantry and warehouse capture remain in Simulation across restarts.

### Demo stock prerequisites

B1-01 and B1-02 must each be **OCCUPIED**, contain exactly one registered SKU,
and have positive recorded stock. The gantry must be idle and the checkout
station clear. Record starting quantities before each run; the application does
not reset inventory automatically.

| Bin | Evidence | Quantity for an unweighed demo part |
| --- | --- | --- |
| B1-01 | Curated local photos | Preserved recorded quantity |
| B1-02 | Labeled inventory illustration | Preserved recorded quantity |

The physical reference procedures below use the supplied item weights from
[putaway-weight.ts](../src/lib/warehouse/putaway-weight.ts). They cannot be run
through this locked public workspace.

## Test 1: read-only agent request

1. In Workspace, enter **What is the current gantry status?**
2. Wait for the response and inspect Activity.
3. Compare bin state and inventory with the starting state.

**Pass:** RackHand reports status using its status tool. No bin moves, no
inventory changes, and no action approval is required.

Optional API check, while the server is running:

```bash
curl -s -X POST http://localhost:3000/api/agent \
  -H 'Content-Type: application/json' \
  -d '{"message":"What is the current gantry status?"}'
```

**Pass:** The response contains an agent message and a status tool result,
rather than a credential/model error.

## Test 2: allowed-bin simulation and lock

Follow the quick browser walkthrough above. Check each allowed bin separately:
checkout completes after approval, the comparison identifies simulated evidence,
and return restores the bin to its original shelf slot. A demo part without a
known item weight retains its recorded quantity and has no invented weight.

Open the floating guide with a click or tap. Confirm that Escape, its close
button, and clicking outside dismiss it. It should remain visible above the
rack panel rather than being clipped by the rack image.

Request movement of B3-03 and confirm no gantry operation or bin reservation
starts. A direct POST of `{"mode":"PROD"}` to
`/api/warehouse/audit-capture-mode` must return HTTP 403 with
`simulation_mode_locked`. GET must still report `SIMULATION`, `locked: true`,
and eligible bins `B1-01`, `B1-02`.

**Pass:** Both allowed bins complete simulated checkout and return. Other bins
cannot move, and neither UI input, API requests nor environment settings enable
Prod mode.

## Test 3: cancel before execution

1. With all bins back and the gantry idle, start the control-module prompt again.
2. Click **Cancel** on **Ready to start** before its countdown expires.
3. Inspect the bins, inventory, and History.

**Pass:** This cancelled request causes no new bin movement or inventory change.
If the countdown has already started execution, this is no longer a test of
cancellation before authorization; finish the current job before retrying.

## Test 4: production scale counting and engineer consumption

Configure the [Pi camera/scale worker](../hardware/warehouse-camera/README.md),
use matching device credentials, and point its `SERVER_BASE_URL` at the running
application. Set **Audit capture mode** to **Prod**. Ensure the actual empty box
weighs 107 g and the scale reports the gross weight including the box.

For a clean bearing test:

1. Record 11 bearings in B4-01 and place 11 correct 19 g bearing items in the box.
2. Ask **Retrieve the bin B4-01.** Authorize the displayed request, or observe
   its automatic retrieval countdown.
3. At verification, confirm a stable gross reading near **316 g**.
4. Confirm that the comparison verifies **11** items.
5. While the bin is at checkout, remove two items before the return countdown
   completes. Use the displayed return action to return the bin.
6. Confirm the return measurement is near **278 g** and the remaining count is **9**.
7. Confirm the informational notice says **Engineer took 2 items** above the
   comparison images, followed by automatic return.
8. Open B4-01's bin dialog and inspect the latest snapshot and current stock.

**Pass:** Return quantity is nine, box tare is 107 g, item weight is 19 g, and
stock reconciles to nine. The return notice uses the engineer-consumption
wording. A changed count detected at checkout uses the mismatch wording.

Use these readings to check other supplied weights:

| Part                  | Initial count | Initial gross weight | Remaining count after taking 2 | Return gross weight |
| --------------------- | ------------: | -------------------: | -----------------------------: | ------------------: |
| Spacer, 6.2 g         |            30 |                293 g |                             28 |             280.6 g |
| Bearing, 19 g         |            11 |                316 g |                              9 |               278 g |
| Motor driver, 47.12 g |             4 |             295.48 g |                              2 |            201.24 g |
| Sensor module, 1.56 g |            20 |              138.2 g |                             18 |            135.08 g |

Every expected quantity comes from:

```text
count = round((total_weight − 107) / supplied_item_weight)
```

The camera still checks identity, visibility, confidence, and foreign objects.
It does not establish item weight or override quantity from a valid scale
reading. Use homogeneous items matching the supplied per-item weight for this
test, including the mixed-sensor SKU.

## Test 5: physical verification failures

Run these on dedicated test stock and retain the starting inventory values.

| Test                | Action                                                                             | Expected result                                                               |
| ------------------- | ---------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| Foreign object      | Include an identifiable foreign object with known parts.                           | Warning and retry required; no verified acceptance until corrected.           |
| Missing scale       | Disconnect the scale before requesting verification.                               | Missing evidence is reported; no count is invented or accepted automatically. |
| Unknown item weight | Request verification for a registered SKU without a supplied weight.               | Quantity is unverified; the application requests a known item weight.         |
| Below tare          | Supply a gross reading below 107 g.                                                | Quantity is unverified; the reading is not treated as a net weight.           |
| Ambiguous count     | Unit test a reading halfway between two sensor quantities, such as 123.38 g gross. | No automatic acceptance; quantity requires another valid reading.             |
| Over capacity       | Unit/integration test a scale-derived count above the bin's capacity.              | Acceptance is blocked; do not physically overload a bin.                      |

**Pass:** The affected step stays unresolved and inventory is not reconciled to
an unverified count. Correct the cause and retry before continuing.

## Test 6: upcoming assembly readiness

Configure the [engineering-plan integration](ENGINEERING_PLAN_INTEGRATION.md).
Use released, enabled work rows for the date selected by the application.
For the shortage fixture, make the plan require **19 sensor modules**, record
**20** in B5-01, and place **18** matching 1.56 g modules in the box. Ensure
B5-01 has stale, missing, changed, or unresolved verification evidence so the
server selects it for inspection. A trusted unchanged check under seven days
old may be reused instead.

1. Use **Prod** capture mode and confirm the Pi and scale are available.
2. Open [http://localhost:3000/trig](http://localhost:3000/trig).
3. Click **Analyze upcoming work plan**.
4. Follow the progress in Workspace.
5. Confirm that the sensor bin is selected for verification when freshness
   policy requires it.
6. Confirm a gross reading near **135.08 g**, giving **18** modules.
7. Inspect the final readiness report and the bin's verified inventory.

**Pass:** The report identifies **required 19, physically found 18, short by 1**.
Clear evidence allows reconciliation under the audit rules. Uncertain evidence
leaves stock unchanged and reports the unresolved check. Plan audits use a
report-only review policy rather than the interactive remove/retry flow.

This run is started by the user; the server selects its bin checks internally.
There is no nightly scheduler or implemented external notification delivery.

## Test 7: evidence and refresh behavior

After a completed return:

1. Open the bin dialog and inspect **Latest bin snapshot**.
2. Confirm that its capture time belongs to this test, its quantity matches the
   verified remainder, and the box/net/item weights match the reading.
3. Refresh Workspace and confirm stock and completed history remain visible.
4. Open History and confirm checkout and return records exist.
5. Open Activity and confirm tool calls and results are visible.

**Pass:** Durable inventory and evidence survive browser refresh. An older
snapshot can still show its historical 117 g tare; a new capture must show
107 g. The displayed **Each** weight for new verified captures is the supplied
item weight, not net weight divided by a camera count.

## Automated checks

From the project directory, with a supported Node.js version:

```bash
npm run lint
npx tsc --noEmit
npx vitest run --config vitest.verification.config.ts
```

The focused verification configuration runs offline unit/component tests and
mocked warehouse workflows. It does not migrate a database or call live models.
It covers counting, confidence gates, checkout/return, approvals, recovery, and
the explicit browser scenario.

A pre-existing test currently asserts a Gemini model name different from the
configured default. Keep that failure visible when running the full focused
suite. To run the remaining checks while explicitly excluding that assertion:

```bash
npx vitest run --config vitest.verification.config.ts \
  -t '^(?!.*uses the supported Gemini)'
```

If type-checking reports syntax errors inside `.next/dev/types/validator.ts`,
those are generated development artifacts; record that separately from source
errors and regenerate Next.js types in a clean development/build session.
Older Node.js 20 versions may fail to load Vitest's ESM dependencies; use the
supported Node.js version above.

### Database integration suite

The full suite migrates and resets a dedicated PostgreSQL test database.
Export a URL whose database name contains `test-warehouse`, then run:

```bash
export TEST_DATABASE_URL='postgresql://test-warehouse:test-warehouse@127.0.0.1:5432/test-warehouse'
npm test
```

Do not point these tests at the application's demo or production database.

### Live provider smoke test

With Bedrock access configured:

```bash
npm run agent:smoke
```

This makes live, billable Bedrock calls. A blocked credential/provider result
means the live agent path was not validated; offline passing tests do not
replace this check.

## Record the result

For each manual test, record:

- Test number, date/time, application build, and capture mode.
- Starting bin/SKU/count and supplied item weight.
- Gross reading, tare, expected count, displayed count, and final inventory.
- Pass/fail, screenshot, and relevant History/Activity entries.
- Whether evidence was scripted or measured by the connected Pi/scale.

A browser-demo pass requires both allowed-bin workflows and a working simulation lock.
A production-verification pass requires fresh measured evidence, 107 g tare,
known item weights, correct scale-derived quantities, and safe failure behavior.
