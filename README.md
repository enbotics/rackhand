# RackHand

[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)

RackHand is an AI-assisted spare-parts warehouse application. It helps users
prepare parts, retrieve and return bins, verify physical inventory with a camera
and scale, and check upcoming assembly plans.

The application uses Next.js, React, TypeScript, Prisma, PostgreSQL/Supabase,
Amazon Bedrock, and Gemini. Bin movement currently runs in a browser-visible
simulation; a Raspberry Pi supplies production camera and scale evidence.

## Architecture

Open the [standalone HTML diagram](public/architecture.html) directly in a
browser, or visit [http://localhost:3000/architecture.html](http://localhost:3000/architecture.html)
while the app is running. It works offline and includes a Print / Save PDF button.
The HTML version starts with three selectable user journeys, then shows each
workflow agent, its tools, and the results passed back to the coordinator.
It explains the Strands feedback loop and user-facing benefits; infrastructure
details are expandable. See the
[hackathon judge brief](docs/hackathon-judge-brief.md) for requirements and
source-code evidence.

### Three workflow agents, with focused tools

```mermaid
flowchart TB
    User["User prompt<br/>Prepare parts or explain an audit"] --> Warehouse
    Warehouse["Warehouse Agent · Strands + Bedrock<br/>Coordinate requests and report tool outcomes"]
    Planner["Materials Planner · Strands + Bedrock<br/>Read plan context, search catalog and inventory<br/>Return required parts and quantities"]
    Auditor["Inventory Auditor · Strands + Bedrock<br/>Read latest audit and history + MemoryManager context<br/>Return an audit explanation"]
    Lookup["9 read/check tools<br/>Parts, stock, bin status, gantry status, and activity"]
    Approval["HumanInTheLoop<br/>Approval before restricted client actions"]
    Graphs["Guarded workflow tools + Strands Graph<br/>fulfill_materials_plan · execute_retrieval<br/>execute_putaway · execute_inventory_audit"]
    Report["User response<br/>Verified outcome, stock changes, or attention needed"]

    Warehouse <-->|"materials_planner · Agent.asTool()"| Planner
    Warehouse <-->|"inventory_auditor · Agent.asTool()"| Auditor
    Warehouse <-->|"Read calls and results"| Lookup
    Warehouse -->|"Restricted client tool call"| Approval
    Approval -->|"Approved execution"| Graphs
    Graphs -->|"Structured execution results"| Warehouse
    Auditor -.->|"run_inventory_audit · trusted internal mode only"| Graphs
    Warehouse --> Report
```

The specialists are branches, not a mandatory Planner → Auditor sequence.
The Warehouse Agent exposes 15 tools in normal client mode: nine read/check
tools, four workflow tools, and two specialist delegations. Its tool list is
defined in [tools/index.ts](src/lib/agents/tools/index.ts).

For prompt-based preparation: request → Warehouse Agent → Materials Planner
→ exact returned requirements → approved fulfillment → verified bin return
→ report. The Auditor is consulted when its audit context is useful.

The separate plan-analysis entry point invokes the Materials Planner directly,
then uses server freshness policy and deterministic audit workflows. It does
not require the Warehouse Agent or Inventory Auditor language agent.
The exact control-module SIMULATION prompt is another explicit exception: its
requirements are server-grounded by the scripted scenario, so it can bypass
the Planner.

There are also two internal Gemini-backed **Strands vision agents**: the Vision
Analyst and conditional Vision Judge. Their GoalLoop refines the same image;
it cannot repeat bin motion or directly update inventory. These are supporting
inspection roles, not user-request coordinators.

<details>
<summary>Full infrastructure and capture architecture</summary>

```mermaid
flowchart TB
    Browser["Browser<br/>Warehouse UI, bin animation, approvals, and reports"]

    subgraph Server["Next.js application server"]
        API["API routes<br/>Requests, approvals, status, and event streams"]
        Agents["Strands AI agents<br/>Warehouse agent + Materials Planner + Inventory Auditor"]
        Plans["Plan analysis service<br/>Check required stock and select bins to verify"]
        Workflows["Strands Graph workflows + approval policies<br/>Retrieve, verify, return, and reconcile inventory"]
        Capture["Camera job and verification services<br/>Durable jobs, evidence checks, and analysis retries"]
        Prisma["Prisma data access"]
    end

    subgraph Cloud["AI and plan providers"]
        Bedrock["Amazon Bedrock<br/>Agent reasoning and tool selection"]
        Gemini["Gemini<br/>Visual count and object identification"]
        Sheets["Google Sheets<br/>Optional read-only engineering plan"]
    end

    subgraph Supabase["Supabase"]
        DB[("PostgreSQL<br/>Catalog, stock, movements, audits, and camera jobs")]
        Storage["Private Storage<br/>Camera evidence photos"]
        Realtime["Realtime<br/>Database change notifications"]
    end

    subgraph Pi["Raspberry Pi 5 - production capture"]
        Worker["Authenticated camera worker"]
        Sensors["Camera Module 3 + USB serial scale"]
    end

    Gantry["Simulated gantry<br/>Bin movement state shown in the browser"]

    Browser <-->|"Prompts, approvals, progress, and results"| API
    API --> Agents
    API --> Plans
    API --> Capture
    Agents <-->|"Model reasoning and responses"| Bedrock
    Agents <-->|"Validated tool calls and structured results"| Workflows
    Agents -->|"Read catalog, stock, and audit history"| Prisma
    Agents -->|"Optional plan lookup"| Sheets
    Plans -->|"Read enabled work"| Sheets
    Plans -->|"Materials Planner requirements"| Agents
    Plans -->|"Selected physical audits"| Workflows
    Workflows --> Gantry
    Workflows --> Capture
    Workflows --> Prisma
    Capture --> Prisma
    Capture -->|"Image analysis"| Gemini
    Capture -->|"Store and read evidence"| Storage
    Prisma --> DB
    DB -.->|"Job and status changes"| Realtime
    Realtime -.->|"Wake and update signals"| API
    API -.->|"Authenticated job events"| Worker
    Worker -->|"Claim jobs, upload photo and weight, report health"| API
    Worker -->|"Capture photo and stable weight"| Sensors
    API -->|"Read movement status"| Gantry
```

Solid arrows show requests or data access; dotted arrows show notifications.
The warehouse agent delegates planning and audit explanations to specialist
agents. Plan analysis can also invoke the Materials Planner directly.

Models select tools and interpret images; server workflows enforce approvals,
evidence requirements, inventory updates, and safe bin return. Bedrock does not
receive the camera image bytes. Gemini handles visual inspection, and server
verification logic combines it with scale evidence.

PostgreSQL is the source of truth. Realtime only signals that work or status
has changed; the Pi claims durable jobs through authenticated server endpoints.
Supabase credentials remain on the server. Bin movement is currently simulated,
not driven by a real gantry. Supported capture simulations use local demo
evidence instead of the Pi.

</details>

## Requirements

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

## Local setup

### 1. Clone the repository and configure the environment

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
| `GANTRY_MODE`               | Keep `simulation`; real gantry control is not implemented.                                                                      |
| `AUDIT_CAPTURE_MODE`        | `PROD` for the Raspberry Pi, or `SIMULATION` for supported demo captures.                                                       |

Bedrock uses the standard AWS credential chain. Configure an AWS profile or set
`AWS_ACCESS_KEY_ID` and `AWS_SECRET_ACCESS_KEY` (plus `AWS_SESSION_TOKEN` for
temporary credentials). A Bedrock bearer token can instead be supplied through
`AWS_BEARER_TOKEN_BEDROCK`.

Keep credentials in `.env.local` or your deployment's secret settings. Never
commit them, expose the Supabase service-role key to the browser, or install
that key on the Pi. `.env` and `.env.local` are both ignored by Git; the tracked
`.env.example` contains configuration examples only.

See the [complete environment reference](#environment-variable-reference) for
all settings, including optional timeouts and simulation controls.

### 2. Install dependencies

```bash
npm ci
```

The install script generates the Prisma client. To regenerate it after a
schema change, run `npm run db:generate`.

### 3. Prepare the database

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

### 4. Start the application

```bash
npm run dev
```

Open [http://localhost:3000/warehouse](http://localhost:3000/warehouse).
Keep the development server running while using the app or the camera worker.

## Camera and scale setup

On the application server, configure:

```env
AUDIT_CAPTURE_MODE=PROD
CAMERA_DEVICE_ID=warehouse-camera-01
CAMERA_DEVICE_TOKEN=replace-with-a-long-random-device-secret
CAMERA_STREAM_URL=http://warehouse-pi.local:8000/stream.mjpg
PUTAWAY_CONTAINER_TARE_GRAMS=107
```

Use the actual empty-bin weight for `PUTAWAY_CONTAINER_TARE_GRAMS`.
On the Pi, copy `hardware/warehouse-camera/camera.env.example` to `camera.env`
in the worker directory. Set `SERVER_BASE_URL` to the application server's
reachable address, not `localhost`, and use the same device ID and token.
Configure the scale's serial device and baud rate, install the Python
dependencies, and start the worker using the
[Pi camera instructions](hardware/warehouse-camera/README.md).

The Raspberry Pi camera is the sole production image source; browser webcam
capture is intentionally not used. Missing or unstable scale readings are
marked as fallback values, not trusted physical measurements.

## Simulation

`GANTRY_MODE=simulation` controls bin movement independently of the camera
mode. It does **not** disable production camera requirements.

Set `AUDIT_CAPTURE_MODE=SIMULATION` or use the warehouse page's mode toggle
for supported local captures. General audit simulation currently supports
`B1-01`; unsupported bins are rejected instead of silently using the Pi.
The explicit control-module browser scenario additionally supports its
server-selected `B4-01`, `B3-03`, and `B6-03` bins when the required inventory
is already configured. It is started with:

> RackHand, prep the parts for the control module.

Simulation still writes to the configured warehouse database. Use a dedicated
development/demo database, not production. The browser mode toggle is local to
the server process and resets to the environment setting after a restart.

## Optional assembly-plan integration

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

## Environment variable reference

This reference covers every parameter in [.env.example](.env.example), including
commented optional settings. Values below are template examples or documented
defaults, not real credentials. Uncomment optional settings in `.env.local`
when needed. Restart the application after changing environment settings.

### Database and Supabase

| Parameter                   | Example / configuration                                | Purpose                                                                         |
| --------------------------- | ------------------------------------------------------ | ------------------------------------------------------------------------------- |
| `DATABASE_URL`              | Your PostgreSQL runtime URL                            | Application queries; use the Supabase transaction pooler when applicable.       |
| `DIRECT_URL`                | Your direct or session-mode PostgreSQL URL             | Prisma generation and migrations. Point at the same database as `DATABASE_URL`. |
| `SUPABASE_URL`              | `https://PROJECT_REF.supabase.co`                      | Supabase project used by camera Storage and Realtime.                           |
| `SUPABASE_SERVICE_ROLE_KEY` | Secret from your Supabase project                      | Server-only access; never expose to the browser or Pi.                          |
| `TEST_DATABASE_URL`         | A dedicated PostgreSQL URL containing `test-warehouse` | Full test suite only. Export in the test terminal; never use production.        |
| `SEED_DEMO_CATALOG`         | `0` to disable; otherwise omit                         | Skip example catalog creation during seeding; shelf bins are still seeded.      |

### Bin movement and verification

| Parameter                             | Example / configuration | Purpose                                                                                                 |
| ------------------------------------- | ----------------------- | ------------------------------------------------------------------------------------------------------- |
| `GANTRY_MODE`                         | `simulation`            | Simulated bin movement. Hardware mode is not implemented.                                               |
| `AUDIT_CAPTURE_MODE`                  | `PROD` or `SIMULATION`  | Initial camera mode; simulation supports only configured demo bins.                                     |
| `GANTRY_SIM_MOVE_DELAY_MS`            | `300`                   | Simulator movement delay, in milliseconds.                                                              |
| `GANTRY_SIM_PICK_DELAY_MS`            | `200`                   | Simulator bin-pick delay, in milliseconds.                                                              |
| `GANTRY_SIM_DROP_DELAY_MS`            | `200`                   | Simulator bin-drop delay, in milliseconds.                                                              |
| `GANTRY_SIM_HOME_DELAY_MS`            | `400`                   | Simulator homing delay, in milliseconds.                                                                |
| `GANTRY_SIM_BIN_TRANSFER_DELAY_MS`    | `5000`                  | Guided bin presentation/return delay, in milliseconds.                                                  |
| `PUTAWAY_INACTIVITY_TIMEOUT_MS`       | `240000`                | Workflow inactivity window, in milliseconds; successful camera/retry transitions refresh it.            |
| `PUTAWAY_CONTAINER_TARE_GRAMS`        | `107`                   | Empty-bin weight subtracted from scale readings; configure the actual weight in grams.                  |
| `PUTAWAY_FALLBACK_TOTAL_WEIGHT_GRAMS` | `150`                   | Fallback gross weight in grams when no usable scale reading is supplied; not trusted physical evidence. |

### Camera worker connection and capture limits

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

### Bedrock and Gemini

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

### Optional engineering-plan integration

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

## Production run

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

## Checks and tests

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

## Warehouse agents

The server-side `warehouse-agent` is the client-facing orchestrator. It owns
the read tools plus the deterministic putaway, whole-bin retrieval and
physical inventory-audit workflows. `inventory-auditor-agent` is mounted under
it with Strands `Agent.asTool()`; it is not a second client endpoint.

- **Model provider:** Amazon Bedrock via `@strands-agents/sdk`. The model id
  is set by `BEDROCK_MODEL_ID` (code default if unset:
  `us.amazon.nova-lite-v1:0`). Use a model your AWS account can access.
  Credentials come from the standard AWS chain and are never committed.
- **Vision:** Gemini (`GEMINI_API_KEY`) performs scan measurement and the
  shared one-frame quantity/confidence/foreign-object analysis used by putaway
  and inventory auditing. Image bytes are not put into either agent's
  conversation.
- **Camera:** manual scans, putaway verification and inventory audits create
  durable `CameraCaptureJob` rows for the configured Raspberry Pi worker.
  The Pi uploads one fresh JPEG; the server dispatches it to measurement or
  shared bin-analysis logic according to the job purpose.
- **Warehouse truth:** PostgreSQL/Supabase is authoritative. Audit evidence is
  stored in Supabase Storage and audit/count history is persisted in dedicated
  database tables.
- **Physical authorization:** client-origin putaway, retrieval and audit calls
  pause at the main agent's deterministic HITL allowlist. Trusted internal
  construction is selected only in server code; prompt text cannot enable it.

### Invoking it

```bash
curl -s -X POST http://localhost:3000/api/agent \
  -H 'Content-Type: application/json' \
  -d '{"message":"What is the current gantry status?"}'
```

```json
{
  "message": "...",
  "agent": "warehouse-agent",
  "model": "...",
  "toolCalls": ["get_gantry_status"]
}
```

Messages must be a non-empty string of at most 4000 characters. Requests are
stateless — there is no conversation memory yet.

### Inventory Auditor behavior

For each requested bin, the deterministic audit graph locks it as `AUDITING`,
moves the whole bin to `SCAN_STATION`, captures exactly one camera frame,
returns it to its original slot, then evaluates reconciliation. Inventory is
updated only when the applicable confidence and physical-evidence checks pass,
including object identity, foreign-object detection, capacity, safe return,
and an unchanged inventory baseline. Zero is a valid count. Uncertain
observations are retained for review without changing inventory.

There is deliberately no nightly scheduler. Audits run only for an approved
client request or a trusted server-selected invocation while the gantry is
idle. Latest and previous per-bin snapshots remain queryable through the
auditor agent.

## License

RackHand is licensed under the [MIT License](LICENSE).

Commit and push the root `LICENSE` file to your repository's default branch
so GitHub can display **MIT license** in the repository's About/sidebar area.
See [GitHub's license instructions](https://docs.github.com/en/communities/setting-up-your-project-for-healthy-contributions/adding-a-license-to-a-repository).
