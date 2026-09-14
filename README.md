# RackHand

[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)

RackHand is an AI-assisted spare-parts warehouse application. It helps users
prepare parts, retrieve and return bins, verify physical inventory with a camera
and scale, and check upcoming assembly plans.

The application uses Next.js, React, TypeScript, Prisma, PostgreSQL/Supabase,
Amazon Bedrock, and Gemini. Bin movement currently runs in a browser-visible
simulation; a Raspberry Pi supplies production camera and scale evidence.

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

| Setting | Purpose |
| --- | --- |
| `DATABASE_URL` | PostgreSQL connection used by the running application. For Supabase, use the transaction pooler URL. |
| `DIRECT_URL` | PostgreSQL connection used by Prisma migrations. Use a direct connection or session-mode pooler, not a transaction-mode pooler. |
| `SUPABASE_URL` | Your Supabase project URL. |
| `SUPABASE_SERVICE_ROLE_KEY` | Server-only Supabase key for camera Storage and Realtime. |
| `AWS_REGION` | AWS region where your selected Bedrock model is accessible. |
| `BEDROCK_MODEL_ID` | Bedrock model or inference-profile ID enabled for your account. |
| `GEMINI_API_KEY` | Gemini key for camera measurement and inventory verification. |
| `GANTRY_MODE` | Keep `simulation`; real gantry control is not implemented. |
| `AUDIT_CAPTURE_MODE` | `PROD` for the Raspberry Pi, or `SIMULATION` for supported demo captures. |

Bedrock uses the standard AWS credential chain. Configure an AWS profile or set
`AWS_ACCESS_KEY_ID` and `AWS_SECRET_ACCESS_KEY` (plus `AWS_SESSION_TOKEN` for
temporary credentials). A Bedrock bearer token can instead be supplied through
`AWS_BEARER_TOKEN_BEDROCK`.

Keep credentials in `.env.local` or your deployment's secret settings. Never
commit them, expose the Supabase service-role key to the browser, or install
that key on the Pi. `.env` and `.env.local` are both ignored by Git; the tracked
`.env.example` contains configuration examples only.

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
PUTAWAY_CONTAINER_TARE_GRAMS=117
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
  `global.anthropic.claude-sonnet-5`). Use a model your AWS account can access.
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
{ "message": "...", "agent": "warehouse-agent", "model": "...", "toolCalls": ["get_gantry_status"] }
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
