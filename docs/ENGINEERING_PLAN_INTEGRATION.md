# Engineering plan integration

The Materials Planner reads project context from the `UpdatedPlan` tab in the
RackHand Engineering Build Plan Google Sheet. It uses that context only to
understand the engineer's current work, scale, material hints, and constraints.
Catalog identity and inventory remain authoritative inside RackHand.

`UpdatedPlan` stores one released material per row using the operational
snake_case headers. The integration also accepts the original `Daily Plan`
headers for backward compatibility.

## Flow

1. An engineer adds one `PREPARE`/`RELEASED` row per required material.
2. The engineer asks RackHand something like: `I am building the mobile assembly workbench. What do I need today?`
3. The Materials Planner calls `get_engineering_plan_context` once using the
   distinctive project/build terms.
4. It resolves candidate materials through `search_catalog` and
   `search_inventory` and returns real, stocked SKUs to the RackHand Agent.
5. RackHand calls `fulfill_materials_plan` with the Planner's exact output.
6. The workflow pauses for operator approval. Nothing has moved at this point.
7. After approval, RackHand revalidates stock, selects enough occupied bins to
   cover every quantity, and retrieves the first selected bin to `OUTPUT`.
8. The engineer removes the requested items, approves the return, and completes
   the existing fresh-photo comparison. Only after that bin is safely returned
   does RackHand offer the next selected bin.

The Sheet never authorizes a movement, supplies trusted SKUs, or changes stock.
In `UpdatedPlan`, only `PREPARE` rows with `plan_status` set to `RELEASED` are
included. In the legacy layout, rows beginning with `EXAMPLE-` and rows whose
`Include for Agent` value is not `Yes` are ignored.

## Runtime setup

Copy the engineering-plan variables from `.env.example` into `.env.local`.
For a private Sheet, create a Google service account with Sheets read-only
access, set `GOOGLE_SERVICE_ACCOUNT_CLIENT_EMAIL` and
`GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY`, then share the Sheet with that service
account email as a Viewer. These two values must come from a real Google Cloud
service-account JSON file; placeholder credentials cannot authenticate.

If the Sheet is intentionally accessible using a Google API key, set
`GOOGLE_SHEETS_API_KEY` instead. Keep every credential in `.env.local`; never
commit it.
