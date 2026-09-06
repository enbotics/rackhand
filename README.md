# webcam-scan

Just a demo project for testing webcam accuracy

## Warehouse Agent (Milestone 5)

A single Strands agent, `warehouse-agent`, runs server-side and answers
operator questions about the warehouse.

- **Model provider:** Amazon Bedrock via `@strands-agents/sdk`, model
  `global.anthropic.claude-sonnet-4-6` (override with `BEDROCK_MODEL_ID`).
  Credentials come from the standard AWS chain — nothing is hard-coded, and no
  AWS secret belongs in the committed `.env`.
- **Separate from vision:** Gemini (`GEMINI_API_KEY`) still does all scanning
  and measurement. The agent never sees an image and never reads that key.

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

### Current tool list

| Tool | Access |
| --- | --- |
| `get_gantry_status` | read-only |

**This milestone provides read-only gantry status only.** The agent has no
tool that can move the gantry, change inventory, or create catalog parts, and
it is given no shell, filesystem, or HTTP capability.

### Live smoke test

`npm run agent:smoke` makes real (billable) Bedrock calls and reports BLOCKED
rather than passing if AWS credentials are unavailable.
