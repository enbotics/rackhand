# RackHand

**Physical AI coworker for hardware engineers.**

> You build hardware. RackHand handles the parts.

RackHand understands an engineer’s assembly goal, plans the required work,
retrieves and returns parts bins, verifies physical inventory, and checks
critical stock before it can block upcoming work.

Built with **Strands Agents** and **Amazon Bedrock**, with a **Next.js**
interface, **PostgreSQL/Supabase**, and a **Raspberry Pi camera and scale**.

[Demo](#demo) · [Architecture](#architecture) · [Testing](public/testing.html) · [Running locally](#running-locally)

[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)

## Why RackHand

Hardware engineers lose skilled time searching bins, counting parts, returning
containers, and repairing inventory records. When software says a part is
available and the bin is empty, assembly stops and investigation begins.

RackHand starts from the engineer’s goal and coordinates the parts work around
it. It checks physical stock, continues when evidence is trustworthy, and
surfaces uncertainty or shortages when the engineer needs to act. The intended
benefit is less time managing inventory and fewer surprises during assembly.

## Demo

Engineer:

> “RackHand, prep the parts for the control module.”

RackHand:

1. Resolves the assembly requirements against the plan, catalog, and inventory.
2. Creates a job spanning the required bins.
3. Presents each bin and verifies its contents.
4. Reconciles trusted inventory differences.
5. Verifies the remainder after the engineer takes parts and returns the bin.
6. Reports completion, shortages, or contents needing attention.

For upcoming work, the plan-analysis flow checks readiness and selects bins
whose physical evidence needs refreshing. A shortage found during verification
appears in the readiness report before assembly begins.

Run the interface at [localhost:3000/warehouse](http://localhost:3000/warehouse).
See [Demo scenarios](#demo-scenarios) for the supported simulation. Public video
and hosted-demo links are not currently documented in this repository.

## Architecture

Open the [interactive architecture diagram](public/architecture.html) directly,
or visit `/architecture.html` on the running application. It includes selectable
user journeys and a Print / Save PDF button.

```mermaid
flowchart LR
    Engineer["Engineer’s goal / upcoming assembly plan"] --> UI["Next.js interface"]
    UI --> RackHand["RackHand / Warehouse Agent<br/>Strands Agents + Amazon Bedrock"]
    RackHand <-->|"Agent.asTool(): requirements"| Planner["Materials Planner"]
    RackHand <-->|"Agent.asTool(): audit context"| Auditor["Inventory Auditor"]
    RackHand <-->|"Tool calls / structured outcomes"| Services["Deterministic workflows<br/>Motion sequencing, verification, inventory"]
    UI --> Plans["Upcoming-plan analysis"]
    Plans --> Planner
    Plans --> Services
    Planner --> Sheets["Google Sheets: read-only plan"]
    Services --> Gantry["Gantry simulator / Klipper macros"]
    Services <-->|"Camera jobs / evidence"| Pi["Raspberry Pi<br/>Camera + serial scale"]
    Services <-->|"Visual inspection"| Vision["Strands vision agents + Gemini"]
    Services <-->|"Warehouse truth / evidence"| Supabase["Supabase PostgreSQL<br/>Storage + Realtime"]
    Services --> UI
```

An engineer’s request enters the Strands-powered RackHand Agent. It delegates
planning and audit interpretation, then invokes guarded services. The camera
and scale return physical evidence; the tool results inform the next decision
and the engineer’s report.

The specialists are selected for the task. They are not a mandatory sequential
chain. Upcoming-plan analysis invokes the Materials Planner and deterministic
audits directly. The explicit control-module simulation can also use
server-grounded scripted requirements without invoking the Planner.

The current repository runs agents inside the Next.js server. Bedrock provides
reasoning; Gemini handles camera images. Image bytes never enter the Warehouse
Agent’s conversation. PostgreSQL is authoritative, Storage retains evidence,
and Realtime signals changes in durable jobs. The Pi uses authenticated server
endpoints and does not hold Supabase administrative credentials.

## How Strands Agents is used

Strands connects an engineering request to scoped capabilities and feeds their
observed results back into the next model turn. The implementation uses the
TypeScript SDK, `@strands-agents/sdk`.

| Strands feature | Use in RackHand | Source |
| --- | --- | --- |
| `Agent` and `BedrockModel` | Warehouse orchestration, planning, and audit interpretation. | [Warehouse Agent](src/lib/agents/warehouse-agent.ts), [model configuration](src/lib/agents/model.ts) |
| `Agent.asTool()` | Mount the Materials Planner and Inventory Auditor as specialist tools. | [Agent construction](src/lib/agents/warehouse-agent.ts) |
| Structured output schemas | Validate specialist requirements and audit responses. | [Materials Planner](src/lib/agents/materials-planner-agent.ts), [Inventory Auditor](src/lib/agents/inventory-auditor-agent.ts) |
| `HumanInTheLoop` | Interrupt restricted client tool calls before execution. | [Approval boundary](src/lib/agents/tools/index.ts) |
| `Graph` | Sequence guarded retrieval, putaway, and inventory-audit workflows. | [Workflow graphs](src/lib/warehouse/graphs) |
| `MemoryManager` | Inject bounded persisted audit-history context into the Auditor. | [Auditor memory store](src/lib/agents/audit-history-memory-store.ts) |
| `GoalLoop` and `GoogleModel` | Refine and evaluate visual evidence using the same image. | [Vision agents](src/lib/geminiAuditCount.ts) |
| Lifecycle hooks | Show tool activity and execution results without exposing private reasoning. | [Trace hooks](src/lib/observability/strands-hooks.ts) |

The visible loop is **OBSERVE → DECIDE → ACT → RESULT**: read the goal and
inventory, select a capability, execute it through services, then use the
returned evidence to continue or report an exception.

### Why Strands

“Prep the parts for the control module” requires intent resolution, a grounded
parts plan, tool selection, and responses to changing physical evidence.
Strands provides the orchestration and specialist delegation for those tasks.
Deterministic services enforce the evidence and reconciliation rules for each
action.

## Agents

| Agent | Responsibility | Boundary |
| --- | --- | --- |
| RackHand / `warehouse-agent` | Coordinate the engineer’s request, invoke specialists and workflows, and report observed outcomes. | Restricted client actions pass through the approval policy. |
| Parts Planning / `materials-planner-agent` | Read the assembly plan, search catalog and stock, and return exact required SKUs and quantities. | Read-only; cannot move bins or change stock. |
| `inventory-auditor-agent` | Explain audit results using latest evidence and history. | Client delegation is read-only. Trusted server construction can enable sequential audit execution. |
| Vision Analyst | Identify contents and anomalies from the captured image. | No inventory-write or motion tools. |
| Vision Judge | Evaluate qualifying image observations independently. | Reuses evidence; cannot recapture or move the rack. |

The Warehouse Agent also retains bounded, server-owned conversation snapshots
per session. This memory and pending approvals are process-local and expire or
reset; authoritative inventory remains in PostgreSQL.

## Tools

The normal Warehouse Agent exposes **15 tools**: nine read/check tools, four
workflow tools, and two specialist delegations. The allowlist is defined in
[tools/index.ts](src/lib/agents/tools/index.ts).

| Capability | Tools |
| --- | --- |
| Status and activity | `get_gantry_status`, `observe_daily_bin_activity` |
| Catalog and inventory | `search_catalog`, `get_part`, `search_inventory`, `match_catalog` |
| Bin lookup | `get_bin_status`, `list_available_bins`, `list_bins` |
| Physical workflows | `execute_retrieval`, `execute_putaway`, `execute_inventory_audit`, `fulfill_materials_plan` |
| Specialist delegation | `materials_planner`, `inventory_auditor` |

The Planner has `get_engineering_plan_context`, `search_catalog`, and
`search_inventory`. The Auditor has `get_latest_inventory_audit` and
`get_inventory_audit_history`; `run_inventory_audit` is enabled only in trusted
internal mode.

Each physical tool invokes a complete guarded workflow. The agent has no
shell, arbitrary code execution, raw SQL, direct inventory mutation, or motor
coordinate tool.

Example API request while the server is running:

```bash
curl -s -X POST http://localhost:3000/api/agent \
  -H 'Content-Type: application/json' \
  -d '{"message":"What is the current gantry status?"}'
```

## Agentic vs deterministic boundary

**AI for judgment. Deterministic control for physics.**

| Agentic responsibilities | Deterministic responsibilities |
| --- | --- |
| Understand the engineer’s goal. | Validate request schemas and authorization. |
| Resolve requirements using plan and stock context. | Sequence bin movement and maintain workflow state. |
| Choose specialists and high-level tools. | Authenticate captures and validate sensor evidence. |
| Interpret structured results and explain exceptions. | Subtract tare and calculate count from known item weight. |
| Decide what capability to invoke next. | Apply confidence, identity, capacity, and inventory-baseline gates. |
| Summarize readiness and shortages. | Commit inventory updates and complete safe return. |

Models do not generate motor coordinates, invent scale readings, calculate
inventory quantities, or bypass reconciliation rules. Once an authorized
workflow starts, its safe sequencing and writes belong to the services.

## Hardware

The production sensing path uses a **Raspberry Pi 5**, **Camera Module 3**, and
a **USB serial digital scale** at the inspection station. The Python worker
captures images and stable scale samples, claims durable jobs, and uploads
evidence through authenticated application endpoints.

The rack uses bins and a three-axis gantry. The public demo defaults to simulated
movement. Private deployments can use the **Klipper gantry controller**, which
sends configured macros through Moonraker at `https://kli-prod.enbotics.tech`.
Klipper owns calibrated movement and gripper control; RackHand owns approvals,
workflow sequencing, camera/scale verification, and inventory commits.

The server queries readiness, homed axes, and printer activity before movement,
posts a macro to `/printer/gcode/script`, appends `M400` to wait for queued motion,
and checks readiness again before reporting completion. See the
[Moonraker printer API](https://moonraker.readthedocs.io/en/latest/external_api/printer/)
and [Klipper G-code documentation](https://www.klipper3d.org/G-Codes.html).

See [Pi camera and scale setup](hardware/warehouse-camera/README.md) and
[camera.env.example](hardware/warehouse-camera/camera.env.example). The Pi’s
`SERVER_BASE_URL` must point to the reachable application server, and its device
ID and token must match the server. The production path uses the Pi camera.

## Physical verification

The scale determines quantity from a supplied item weight:

```text
net_weight = total_weight − box_tare
count = round(net_weight / item_weight)
items_taken = previous_verified_count − remaining_verified_count
```

The default box tare is **107 g**, configurable with
`PUTAWAY_CONTAINER_TARE_GRAMS`. Item weights are explicitly supplied in
[putaway-weight.ts](src/lib/warehouse/putaway-weight.ts):

| Part | Item weight |
| --- | ---: |
| `HARDWARE-ROUND-SPACER` | 6.2 g |
| V-groove bearing wheel hardware kit | 19 g |
| `DRIVER-MKS-TMC2160-OC-V1` | 47.12 g |
| `ELECTRONICS-SENSOR-MODULE-MIXED` | 1.56 g |

Item weight is never inferred by dividing total or net weight by a camera
count. An unknown item weight, missing scale data, reading below tare, or an
ambiguous rounded quantity prevents verified acceptance. Readings near the
boundary between two quantities are rejected using a residual tolerance of
45% of one item’s weight. An empty bin is valid when its total equals tare.

The camera supplies identity, visibility, confidence, and foreign-object
checks. Its proposed object count does not replace the scale-derived count.
Putaway requires confidence above 60%, alongside the applicable evidence and
capacity gates. Trusted results are accepted automatically after five seconds;
unsafe observations require correction and verification again.

On return, a verified decrease is shown as “Engineer took X items,” and the
remaining quantity is reconciled through the workflow. A discrepancy detected
before retrieval is shown as an inventory mismatch. Photos, quantities, scale
values, and movements are retained as evidence. Existing snapshots keep their
original recorded values; changing configuration affects new verification.

## Running locally

### Requirements

- Node.js **22.12 or later in the 22.x series**, or **24.x**, with npm. Prisma
  also supports Node.js 20.19 or later in the 20.x series.
- A Supabase project with PostgreSQL, Storage, and Realtime for camera workflows.
- AWS credentials with access to the Bedrock model you configure, for the agent.
- A Gemini API key for image analysis.
- For production captures: a Raspberry Pi 5, Camera Module 3, and a supported
  USB serial scale. See [camera setup](hardware/warehouse-camera/README.md).

The page can run without a connected camera, but production physical checks
cannot complete without the camera worker. Simulation is limited to supported
demo bins; it is not a replacement for every camera workflow.

### Setup

#### 1. Clone the repository and configure the environment

Open a terminal in the cloned project directory, then copy the template:

```bash
cp .env.example .env.local
```

Edit `.env.local` and replace the placeholders. Configure these settings before
installing dependencies, because Prisma generation reads `DIRECT_URL`:

| Setting                     | Purpose                                                                                                                         |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `DATABASE_URL`              | PostgreSQL connection used by the running application. For Supabase, use the transaction pooler URL.                            |
| `DIRECT_URL`                | PostgreSQL connection used by Prisma migrations. Use a direct connection or session-mode pooler, not a transaction-mode pooler. |
| `SUPABASE_URL`              | Your Supabase project URL.                                                                                                      |
| `SUPABASE_SERVICE_ROLE_KEY` | Server-only Supabase key for camera Storage and Realtime.                                                                       |
| `AWS_REGION`                | AWS region where your selected Bedrock model is accessible.                                                                     |
| `BEDROCK_MODEL_ID`          | Bedrock model or inference-profile ID enabled for your account.                                                                 |
| `GEMINI_API_KEY`            | Gemini key for camera measurement and inventory verification.                                                                   |
| `WAREHOUSE_SIMULATION_LOCKED` | Default `true` protects the public demo. Only a private server setting of `false` unlocks physical deployment.                 |
| `GANTRY_MODE`               | `simulation` by default; `production` selects Klipper when the server lock is disabled.                                        |
| `AUDIT_CAPTURE_MODE`        | `SIMULATION` for the public demo; `PROD` is required with the production gantry.                                                 |
| `KLIPPER_BASE_URL`          | Moonraker API URL: `https://kli-prod.enbotics.tech`. Set `KLIPPER_API_KEY` if authentication requires it.                         |

Bedrock uses the standard AWS credential chain. Configure an AWS profile or set
`AWS_ACCESS_KEY_ID` and `AWS_SECRET_ACCESS_KEY` (plus `AWS_SESSION_TOKEN` for
temporary credentials). A Bedrock bearer token can instead be supplied through
`AWS_BEARER_TOKEN_BEDROCK`.

Keep credentials in `.env.local` or your deployment's secret settings. Never
commit them, expose the Supabase service-role key to the browser, or install
that key on the Pi. `.env` and `.env.local` are both ignored by Git; the tracked
`.env.example` contains configuration examples only.

See the [environment variable reference](#environment-variable-reference) for
all settings, including optional timeouts and simulation controls.

#### 2. Install dependencies

```bash
npm ci
```

The install script generates the Prisma client. To regenerate it after a
schema change, run `npm run db:generate`.

#### 3. Prepare the database

Check that both database URLs point to the intended development database, then
apply the committed migrations and seed the initial bins and example catalog:

```bash
npm run db:deploy
npm run db:seed
```

The seed preserves existing records. It creates shelf bins and example parts,
not a fully stocked warehouse or the complete control-module demo inventory.
Add your own stock before retrieving parts. Set `SEED_DEMO_CATALOG=0` to skip
the example catalog.

For a new schema change during development, use `npm run db:migrate`.
`npm run db:reset` is destructive and is **not** part of normal setup.

#### 4. Start the application

```bash
npm run dev
```

Open [http://localhost:3000/warehouse](http://localhost:3000/warehouse).
Keep the development server running while using the app or the camera worker.

### Assembly-plan integration

To analyze an engineering plan, configure:

- `ENGINEERING_PLAN_SPREADSHEET_ID`: your spreadsheet ID.
- `ENGINEERING_PLAN_SHEET_RANGE`: the range containing the plan; the template
  uses `UpdatedPlan!A1:O250`.
- `ENGINEERING_PLAN_TIME_ZONE`: the time zone used to select the upcoming day.
- `GOOGLE_SERVICE_ACCOUNT_CLIENT_EMAIL` and
  `GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY`: credentials for a service account with
  read access to the spreadsheet. Share the sheet with this email and enable
  the Google Sheets API for its project.

`GOOGLE_SHEETS_API_KEY` is an alternative only when the spreadsheet is
intentionally accessible through API-key access. This integration reads the
plan; it does not edit it.

### Automatic analysis of upcoming work

RackHand can start the upcoming-work analysis by itself when the plan changes.
Editing the sheet is the only action required; nobody has to open the app.

```text
Sheet edit  ->  signed webhook  ->  debounced inbox  ->  queued plan card
            ->  wait for a safe idle warehouse  ->  analysis + bin checks
```

Disabled by default. Enable it only on the single deployment that owns the
physical warehouse — two servers draining the same queue would compete for the
same gantry. See [the setup runbook](docs/automatic-plan-trigger.md) for the
Apps Script installation and the production rollout steps.

- **What sends the event.** A bound Apps Script
  ([`hardware/google-sheets/rackhand-plan-trigger.gs`](hardware/google-sheets/rackhand-plan-trigger.gs))
  fires on edit, on structural change, and on the first open of each day. It
  POSTs an HMAC-SHA256 signed body carrying only the spreadsheet ID and a
  timestamp to `/api/agent/plan-analysis/sheet-change`. Failed deliveries retry
  up to five times and surface an honest error in Apps Script Executions rather
  than reporting success.
- **What the server trusts.** The event is a notification, not data. The server
  verifies the signature and timestamp, then re-reads the plan itself through
  the existing read-only Sheets integration. Nothing from the request body
  reaches the analysis.
- **Why it does not thrash.** Edits debounce for 15 seconds, and the re-read
  plan is fingerprinted — formatting and row-order changes that leave the
  actionable rows identical queue no work. A newer edit supersedes a version
  still waiting, so only the latest plan is ever analyzed.
- **When it actually runs.** A queued analysis waits for the warehouse to be
  genuinely free: no client request, no pending approval, every bin on the
  shelf, no unfinished movement or audit, camera free, and the gantry idle and
  home. These are database and hardware facts, not a browser timer. While it
  waits, the plan card explains what it is waiting for.
- **Where it runs.** A coordinator on the Node server drains the queue every 10
  seconds, so work proceeds with no browser open. This checks the queue and
  idle state only — it does not poll Sheets. Only a signed event causes a read.
- **Recovery.** Analyses are checkpointed between bin checks and hold a
  database lease. A restart mid-analysis fails that run honestly and releases
  it for a fresh attempt; it is never blindly replayed.

Automatic analysis performs no fulfillment and has no human-in-the-loop step.
Unsafe or ambiguous observations are reported as issues in the readiness
report rather than raised as hidden approval prompts.

### Private production gantry setup

In the private application's `.env.local` (or deployment environment), set:

```dotenv
WAREHOUSE_SIMULATION_LOCKED=false
GANTRY_MODE=production
AUDIT_CAPTURE_MODE=PROD
KLIPPER_BASE_URL=https://kli-prod.enbotics.tech
# KLIPPER_API_KEY=your-server-only-moonraker-key
KLIPPER_HOME_MACRO=RACKHAND_HOME
KLIPPER_PUTAWAY_MACRO=RACKHAND_PUTAWAY
KLIPPER_RETRIEVE_MACRO=RACKHAND_RETRIEVE
KLIPPER_PRESENT_BIN_MACRO=RACKHAND_RETRIEVE
KLIPPER_RETURN_BIN_MACRO=RACKHAND_RETURN
KLIPPER_AUDIT_PRESENT_MACRO=RACKHAND_RETRIEVE
KLIPPER_AUDIT_RETURN_MACRO=RACKHAND_RETURN
```

Replace the macro bindings with your installed names, then restart RackHand.
The hostname must route `/printer/*` requests to Moonraker; a dashboard HTML
page alone is insufficient. Credentials stay on the application server. The
header displays **GANTRY MODE: PRODUCTION** and the rack badge shows
**Production · Klipper**. All configured rack positions `B1-01` through `B6-05`
are available through the usual warehouse checks and approval workflow.

#### Required macro contract

Macro bindings default to the names above; RackHand does not install them on
the machine. Home receives no parameters. Every bin macro receives:

```text
BIN=B6-03 BED=6 SLOT=3 STATION=OUTPUT
```

`BED` and `SLOT` identify the calibrated shelf position. `STATION` is the
destination for retrieval/presentation and the source for return/putaway:
`OUTPUT`, `INTAKE`, or `SCAN_STATION`. For example, a retrieval sends:

```gcode
RACKHAND_RETRIEVE BIN=B6-03 BED=6 SLOT=3 STATION=OUTPUT
M400
```

Your macros must implement the corresponding complete, calibrated transfer,
including gripper actions and failure checks. Return and putaway must park the
unloaded carriage after shelving the bin. Keep transfers synchronous: a macro
that schedules `delayed_gcode` and returns early cannot provide completion
through this controller. If existing macros use other parameter names, add
Klipper wrapper macros that accept this contract and call the existing macros;
see [Klipper command templates](https://www.klipper3d.org/Command_Templates.html).

Confirm the installed macro names using the read-only Moonraker
`GET /printer/gcode/help` endpoint or your Klipper dashboard. Home the machine
from that dashboard before starting a bin workflow. Connect and authenticate
the Pi camera/scale worker as described in the hardware setup. Raw development
gantry endpoints are disabled whenever the production controller is selected,
including under `next dev`; real transfers use approved warehouse workflows.

Requests are serialized using the warehouse hardware lease. Macro errors,
timeouts, unexpected acknowledgements, or failed post-movement status checks
produce a failed movement, preserve bin reservations and idempotency, and block
further commands in that server process.
RackHand never resends an uncertain command automatically: the machine may
continue moving after an HTTP timeout. Inspect the machine and reconcile bin
and workflow state before restarting the application. Use one persistent
application process for production control; operation history and this failure
latch are process-local. Mock HTTP tests verify the integration without moving
the real gantry; this repository has not verified the live macro bindings.

<details>
<summary>Environment variable reference</summary>

### Environment variable reference

This reference covers every parameter in [.env.example](.env.example), including
commented optional settings. Values below are template examples or documented
defaults, not real credentials. Uncomment optional settings in `.env.local`
when needed. Restart the application after changing environment settings.

#### Database and Supabase

| Parameter                   | Example / configuration                                | Purpose                                                                         |
| --------------------------- | ------------------------------------------------------ | ------------------------------------------------------------------------------- |
| `DATABASE_URL`              | Your PostgreSQL runtime URL                            | Application queries; use the Supabase transaction pooler when applicable.       |
| `DIRECT_URL`                | Your direct or session-mode PostgreSQL URL             | Prisma generation and migrations. Point at the same database as `DATABASE_URL`. |
| `SUPABASE_URL`              | `https://PROJECT_REF.supabase.co`                      | Supabase project used by camera Storage and Realtime.                           |
| `SUPABASE_SERVICE_ROLE_KEY` | Secret from your Supabase project                      | Server-only access; never expose to the browser or Pi.                          |
| `TEST_DATABASE_URL`         | A dedicated PostgreSQL URL containing `test-warehouse` | Full test suite only. Export in the test terminal; never use production.        |
| `SEED_DEMO_CATALOG`         | `0` to disable; otherwise omit                         | Skip example catalog creation during seeding; shelf bins are still seeded.      |

#### Bin movement and verification

| Parameter                             | Example / configuration | Purpose                                                                                                 |
| ------------------------------------- | ----------------------- | ------------------------------------------------------------------------------------------------------- |
| `WAREHOUSE_SIMULATION_LOCKED`         | `true`                  | Server-only public demo lock. Only explicit `false` permits production settings.                         |
| `GANTRY_MODE`                         | `simulation`            | `production` selects Klipper when unlocked; `PROD` and legacy `HARDWARE` are accepted aliases.             |
| `AUDIT_CAPTURE_MODE`                  | `SIMULATION`            | `PROD` uses physical camera/scale evidence when unlocked. Required for production gantry movement.         |
| `GANTRY_SIM_MOVE_DELAY_MS`            | `300`                   | Simulator movement delay, in milliseconds.                                                              |
| `GANTRY_SIM_PICK_DELAY_MS`            | `200`                   | Simulator bin-pick delay, in milliseconds.                                                              |
| `GANTRY_SIM_DROP_DELAY_MS`            | `200`                   | Simulator bin-drop delay, in milliseconds.                                                              |
| `GANTRY_SIM_HOME_DELAY_MS`            | `400`                   | Simulator homing delay, in milliseconds.                                                                |
| `GANTRY_SIM_BIN_TRANSFER_DELAY_MS`    | `5000`                  | Guided bin presentation/return delay, in milliseconds.                                                  |
| `PUTAWAY_INACTIVITY_TIMEOUT_MS`       | `240000`                | Workflow inactivity window, in milliseconds; successful camera/retry transitions refresh it.            |
| `PUTAWAY_CONTAINER_TARE_GRAMS`        | `107`                   | Empty-bin weight subtracted from scale readings; configure the actual weight in grams.                  |

#### Klipper / Moonraker

These settings are server-only. Configure installed macro names to match the
contract below; do not put scripts or parameter expressions in the bindings.

| Parameter | Default / example | Purpose |
| --- | --- | --- |
| `KLIPPER_BASE_URL` | `https://kli-prod.enbotics.tech` | Required in production; HTTP(S) Moonraker API root. |
| `KLIPPER_API_KEY` | Optional secret | Moonraker `X-Api-Key` authentication. Omit only if the server is already authorized. |
| `KLIPPER_REQUEST_TIMEOUT_MS` | `90000` | Time allowed for a macro and queued motion to finish. |
| `KLIPPER_STATUS_TIMEOUT_MS` | `5000` | Time allowed for a read-only printer status request. |
| `KLIPPER_HOME_MACRO` | `RACKHAND_HOME` | Home X, Y and Z. |
| `KLIPPER_PUTAWAY_MACRO` | `RACKHAND_PUTAWAY` | Store a bin from INTAKE and park the unloaded carriage. |
| `KLIPPER_RETRIEVE_MACRO` | `RACKHAND_RETRIEVE` | Fetch a bin to OUTPUT. |
| `KLIPPER_PRESENT_BIN_MACRO` | `RACKHAND_RETRIEVE` | Present a shelf bin at INTAKE for guided putaway. |
| `KLIPPER_RETURN_BIN_MACRO` | `RACKHAND_RETURN` | Return a bin from OUTPUT or INTAKE and park the unloaded carriage. |
| `KLIPPER_AUDIT_PRESENT_MACRO` | `RACKHAND_RETRIEVE` | Present a bin at SCAN_STATION for an audit. |
| `KLIPPER_AUDIT_RETURN_MACRO` | `RACKHAND_RETURN` | Return a bin from SCAN_STATION and park the unloaded carriage. |

#### Camera worker connection and capture limits

These are application-server settings. The Pi has its own
[camera.env.example](hardware/warehouse-camera/camera.env.example); its
`CAMERA_DEVICE_ID` and `CAMERA_DEVICE_TOKEN` must match the server.

| Parameter                           | Example / configuration                      | Purpose                                                                      |
| ----------------------------------- | -------------------------------------------- | ---------------------------------------------------------------------------- |
| `CAMERA_DEVICE_ID`                  | `warehouse-camera-01`                        | Identifies the authenticated Pi worker.                                      |
| `CAMERA_DEVICE_TOKEN`               | Your long random device secret               | Authenticates the Pi; keep private on the server and Pi.                     |
| `CAMERA_STREAM_URL`                 | `http://warehouse-pi.local:8000/stream.mjpg` | Pi's reachable live-preview URL.                                             |
| `CAMERA_CAPTURE_TIMEOUT_SECONDS`    | `120`                                        | Renewable lease duration after a worker claims a capture, in seconds.        |
| `CAMERA_ABANDONED_TIMEOUT_SECONDS`  | `86400`                                      | Long-stop cleanup interval for abandoned queued captures, in seconds.        |
| `CAMERA_PROCESSING_TIMEOUT_SECONDS` | `300`                                        | Processing lease limit for an uploaded frame, in seconds.                    |
| `CAMERA_MAX_UPLOAD_MB`              | `12`                                         | Maximum accepted JPEG upload size, in MB.                                    |
| `CAMERA_CAPTURE_DIR`                | `data/camera-captures` by default            | Local capture directory; override with a persistent absolute path if needed. |

#### Bedrock and Gemini

Use either the standard AWS credential chain or a Bedrock bearer token;
not every credential parameter needs to be set.

| Parameter                  | Example / configuration                          | Purpose                                                                                                             |
| -------------------------- | ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------- |
| `AWS_REGION`               | `us-west-2`                                      | AWS region used for Bedrock requests.                                                                               |
| `BEDROCK_MODEL_ID`         | Code default: `us.amazon.nova-lite-v1:0`         | Choose an accessible Bedrock model/inference profile; ids require the supported inference-profile prefix (`us.`/`global.`). |
| `AWS_BEARER_TOKEN_BEDROCK` | Secret Bedrock bearer token                      | Alternative Bedrock authentication.                                                                                 |
| `AWS_ACCESS_KEY_ID`        | Your AWS access key ID                           | AWS signature-based authentication, paired with the secret key.                                                     |
| `AWS_SECRET_ACCESS_KEY`    | Your AWS secret access key                       | Secret for AWS signature-based authentication.                                                                      |
| `AWS_SESSION_TOKEN`        | Your temporary AWS session token                 | Required when using temporary AWS access-key credentials.                                                           |
| `GEMINI_API_KEY`           | Your Google AI Studio API key                    | Camera measurement and image-based inventory analysis.                                                              |

#### Optional engineering-plan integration

Configure these only when using spreadsheet-based plan analysis. For private
sheets, use the service account and share the sheet with its email.

| Parameter                             | Example / configuration                      | Purpose                                                                      |
| ------------------------------------- | -------------------------------------------- | ---------------------------------------------------------------------------- |
| `ENGINEERING_PLAN_SPREADSHEET_ID`     | Replace `YOUR_SPREADSHEET_ID`                | Spreadsheet containing the engineering plan.                                 |
| `ENGINEERING_PLAN_SHEET_RANGE`        | `UpdatedPlan!A1:O250`                        | Sheet tab and cell range to read.                                            |
| `ENGINEERING_PLAN_TIME_ZONE`          | `Asia/Ulaanbaatar`                           | Time zone used to determine the upcoming plan date.                          |
| `GOOGLE_SERVICE_ACCOUNT_CLIENT_EMAIL` | Your service-account email                   | Read-only spreadsheet authentication identity.                               |
| `GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY`  | Secret PEM key, quoted with `\n` line breaks | Service-account key paired with its email.                                   |
| `GOOGLE_SHEETS_API_KEY`               | Your Google Sheets API key                   | Alternative only for sheets intentionally accessible through API-key access. |
| `ENGINEERING_PLAN_AUTO_ENABLED`       | `false` (default) / `true`                   | Enables automatic analysis when the sheet changes. Enable on the single deployment that owns the warehouse. |
| `ENGINEERING_PLAN_WEBHOOK_SECRET`     | Random secret, 32+ characters                | Shared secret signing the sheet-change webhook. Must match the Apps Script property. |


</details>

### Production application server

Configure the same environment settings on the deployment, then run:

```bash
npm ci
npm run db:deploy
npm run build
npm start
```

The server listens on port 3000 by default. Point the Pi's `SERVER_BASE_URL` at
the deployed server. Rebuild and restart after server-code changes; an existing
production process continues serving its previous build.

### Checks and tests

See the [HTML application testing guide](public/testing.html) (served at `/testing.html`)
for a short browser walkthrough,
production scale checks, expected results, and failure tests.

Lint and type-check:

```bash
npm run lint
npx tsc --noEmit
```

Run the focused verification suite without database migrations, real hardware,
or live model calls:

```bash
npx vitest run --config vitest.verification.config.ts
```

The full suite requires a separate PostgreSQL test database. Its URL must
contain `test-warehouse`; these tests migrate and reset test data. Export the
URL in your terminal, rather than pointing it at your development database:

```bash
export TEST_DATABASE_URL='postgresql://test-warehouse:test-warehouse@127.0.0.1:5432/test-warehouse'
npm test
```

`npm run agent:smoke` makes real, billable Bedrock calls. It reports blocked
when AWS credentials are unavailable; it is not an offline unit test.


## AgentCore deployment

**AgentCore deployment is not implemented or documented in the current
repository.** The Strands agents run in the Next.js application server and call
Amazon Bedrock directly. Using Bedrock does not establish an AgentCore runtime
deployment.

An AgentCore deployment needs a runtime entry point, packaging and deployment
configuration, an authenticated invocation path, and a strategy for the
currently process-local conversation, approval, and gantry state. Those assets
and a tested deployment procedure must be added before this README can claim
an AgentCore deployment.

## Demo scenarios

### Locked browser simulation

The public workspace locks gantry and warehouse capture to Simulation because
Prod mode can trigger real hardware. Only stocked `B1-01` and `B1-02` may move.
Simulation info opens by default as a floating dialog. Dismiss it with **Got it**
or reopen it from **Simulation · Locked** beside the rack menu.

Try **Bring me bin B1-01** or **Bring me bin B1-02**, approve the request in
chat, then return the checked-out bin before requesting another.
`B1-01` uses curated photos; `B1-02` uses a labeled illustration and scripted
inspection of recorded inventory, without a physical camera or scale reading.
Demo parts without a configured item weight retain their recorded quantity;
simulation never derives an item weight from an image count.
The earlier control-module scenario uses `B4-01`, `B3-03`, and `B6-03` and
is unavailable under this lock.

### Upcoming-work shortage

Configure the optional Google Sheet integration and run upcoming-plan analysis.
The server selects physical checks when evidence is stale, missing, changed,
or unresolved. A trusted unchanged check can be reused; freshness expires at
seven days.

A useful demonstration is a sensor-array plan requiring 19 modules when records
show 20 but a physical check finds 18. The final report is short by one. These
are scenario values: configure the plan and stock to reproduce them. Plan
analysis starts either from an operator in the app or automatically when the
sheet changes (see [Automatic analysis of upcoming work](#automatic-analysis-of-upcoming-work));
its bin checks are internally selected in both cases. Automatic runs are
event-driven — there is no nightly scheduler, no Sheets polling, and no
implemented email/chat notification service.

### Production sensing

The public deployment keeps physical sensing and movement disabled. A private
hardware deployment must explicitly disable the server lock and configure both
capture and gantry modes; posting `PROD` to the mode API cannot switch modes.

### Simulation configuration

With `WAREHOUSE_SIMULATION_LOCKED=true` (the default), both gantry and warehouse
capture remain in Simulation across server restarts.
Only `B1-01` and `B1-02` may move; all other bins remain available for read-only
inspection. The server enforces this limit for retrieval, putaway, returns and
audits, including direct movement endpoints. Simulation writes to the
configured database, so use a development/demo database.

## Safety / failure behavior

| Situation | Behavior |
| --- | --- |
| Restricted client workflow requested | Strands `HumanInTheLoop` interrupts before execution. Trusted internal mode is selected only by server code. |
| Unknown item weight or missing/invalid scale evidence | Quantity is unverified; no automatic quantity-changing acceptance. |
| Foreign objects, wrong part, uncertain visibility, or inadequate confidence | Preserve evidence and require attention or a retry. |
| Estimated count exceeds bin capacity | Reject verified acceptance and request correction. |
| Analysis fails | Retain the image; supported putaway analysis can retry the saved frame. |
| Stale/superseded capture or changed inventory baseline | Reject or withhold reconciliation. |
| Duplicate automatic acceptance | Acceptance is idempotent to handle client/server races. |
| Browser closes during trusted verification | Server-owned automatic acceptance continues the workflow. |
| Return verification fails | Keep stock unapproved and do not complete a successful return. |
| Klipper macro fails or completion is uncertain | Fail the movement, block further commands, and require machine/bin reconciliation before restarting. No automatic command retry. |

Interactive retrieve/return checks can ask for removal and retry. Upcoming-plan
audits retain report-only review outcomes; they do not use the same interaction.
Sequential audit workflows preserve bin ownership and original return location.

## Project structure

```text
src/app/                         Next.js pages and API routes
src/components/warehouse/        Warehouse UI, capture dialogs, approvals, reports
src/lib/agents/                  Strands orchestrator, specialists, scoped tools
src/lib/warehouse/               Inventory, verification, and workflow services
src/lib/warehouse/graphs/        Guarded Strands workflow graphs
src/lib/engineering-plan/        Google Sheets integration and readiness analysis
src/lib/camera/                  Durable camera jobs, evidence, and worker access
src/lib/gantry/                  Controller interface and simulated motion
src/lib/observability/           Tool and graph tracing
hardware/warehouse-camera/       Python Pi camera and serial-scale worker
hardware/google-sheets/          Apps Script that signals plan changes
prisma/                          Database schema, migrations, and seed
public/architecture.html         Interactive architecture diagram
scripts/                         Setup and smoke-test utilities
tests/                           Unit, component, and database integration tests
docs/                            Supporting implementation and demo notes
```

## Pre-existing work disclosure

The repository does not currently contain a confirmed build-history disclosure.
The origin and dates of any pre-existing rack/mechanical hardware, camera/scale
setup, prior software, or reused non-standard code must be supplied by the
maintainers. No claim that all hardware or software was created during the
hackathon is made here.

For the final submission, record the exact reused components, their origin and
dates, and which agent system, tools, workflows, interface, integrations, and
demo assets were built during the submission period.

## License

RackHand is licensed under the [MIT License](LICENSE).
