# Engineering plan integration

The Materials Planner reads project context from the `Daily Plan` tab in the
RackHand Engineering Build Plan Google Sheet. It uses that context only to
understand the engineer's current work, scale, material hints, and constraints.
Catalog identity and inventory remain authoritative inside RackHand.

## Flow

1. An engineer adds one enabled row per work day and project.
2. The engineer asks RackHand something like: `I am building the mobile assembly workbench. What do I need today?`
3. The Materials Planner calls `get_engineering_plan_context` once using the
   distinctive project/build terms.
4. It resolves candidate materials through `search_catalog` and
   `search_inventory` and returns real, stocked SKUs to the RackHand Agent.
5. RackHand starts the existing materials-availability verification flow.

The Sheet never authorizes a movement, supplies trusted SKUs, or changes stock.
Rows beginning with `EXAMPLE-` and rows whose `Include for Agent` value is not
`Yes` are ignored deterministically before content reaches the planner.

## Runtime setup

Copy the engineering-plan variables from `.env.example` into `.env.local`.
For a private Sheet, create a Google service account with Sheets read-only
access, set `GOOGLE_SERVICE_ACCOUNT_CLIENT_EMAIL` and
`GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY`, then share the Sheet with that service
account email as a Viewer.

If the Sheet is intentionally accessible using a Google API key, set
`GOOGLE_SHEETS_API_KEY` instead. Keep every credential in `.env.local`; never
commit it.
