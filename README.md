# webcam-scan

Just a demo project for testing webcam accuracy

## Warehouse agents

The server-side `warehouse-agent` is the client-facing orchestrator. It owns
the read tools plus the deterministic putaway, whole-bin retrieval and
physical inventory-audit workflows. `inventory-auditor-agent` is mounted under
it with Strands `Agent.asTool()`; it is not a second client endpoint.

- **Model provider:** Amazon Bedrock via `@strands-agents/sdk`. The model id
  is set by `BEDROCK_MODEL_ID` in `.env` (code default if unset:
  `global.anthropic.claude-sonnet-5`) — check `.env` for what's actually
  configured today, since it's sometimes pinned to a different model when an
  account's Bedrock access to the default changes. Credentials come from the
  standard AWS chain — nothing is hard-coded, and no AWS secret belongs in the
  committed `.env`.
- **Vision:** Gemini (`GEMINI_API_KEY`) performs scan measurement and the
  Inventory Auditor's one-frame quantity count. Image bytes are not put into
  either agent's conversation.
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
updated only when raw confidence is strictly greater than `0.80` and the
countability, occlusion, identity, foreign-object, capacity, evidence, return
and unchanged-baseline gates all pass. Zero is a valid observed count. Every
other observation is retained for review without changing inventory.

There is deliberately no nightly scheduler. Audits run only for an approved
client request or a trusted server-selected invocation while the gantry is
idle. Latest and previous per-bin snapshots remain queryable through the
auditor agent.

### Live smoke test

`npm run agent:smoke` makes real (billable) Bedrock calls and reports BLOCKED
rather than passing if AWS credentials are unavailable.
