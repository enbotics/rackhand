# RackHand — Agents for Humans judge brief

Reviewed September 14, 2026. Recommended track: **Professional Agents**, based
on RackHand's engineering and workshop audience; this is a recommendation,
not confirmation of the track selected on Devpost. The
[track guidance](https://agentsforhumans.devpost.com/details/faqs) says to choose
based on the primary user.

## Submission essentials

- Deadline: September 14, 2026, 5 PM PDT — September 15, 8 AM in Ulaanbaatar.
- Build with Strands; submit a public repository with runnable source/assets,
  setup instructions, README, and detectable MIT or Apache license.
- Include an architecture diagram, AWS Builder ID, and public YouTube/Vimeo
  demo of at most five minutes, covering the problem, audience, and importance.
- Use English or translations. Disclose incorporated prior work; the project
  must be newly created during August 10–September 14.
- Provide free judging access through October 8; hardware access may be requested.

These are a practical summary, not a full eligibility determination. Check
age, residency, ownership, integration rights, and conflicts against the
[official rules](https://agentsforhumans.devpost.com/rules).

AgentCore is optional, though it can strengthen implementation scoring.
RackHand does not currently implement an AgentCore deployment. The
[official resources](https://agentsforhumans.devpost.com/resources) link the
optional deployment guides; no deployment is added or claimed here.

## How to read the architecture

Open [the judge-facing HTML](../public/architecture.html) directly, or serve it
at `/architecture.html`. It works offline; use Print / Save PDF to export.

Start with the selectable **Prepare parts**, **Explain an audit**, and
**Analyze upcoming plan** journeys. Each step names the actor, tool or SDK
feature, and result. The next diagram shows the three workflow agents as
separate boxes, with delegation and returned results labeled. A feature-to-user
benefit table explains Strands' contribution; the infrastructure map is
expandable so it does not overwhelm the user journey.

The page explicitly shows input, the model/tool feedback loop, integrations,
AWS services actually used, and user output, matching the
[architecture FAQ](https://agentsforhumans.devpost.com/details/faqs).

The full connection diagram is a logical overview, not every endpoint.
Bedrock supports the Strands agents; Gemini separately inspects images.
Camera bytes are not sent into the warehouse agent's conversation. Pi access
to captures, jobs, notifications, and health goes through authenticated Next.js
endpoints. PostgreSQL is authoritative; Realtime only signals changes.

### Agent roles and Strands ownership

| Role | Tools / Strands features | Result or responsibility |
| --- | --- | --- |
| Warehouse Agent | `Agent`, nine lookup tools, four workflow tools, and two `Agent.asTool()` specialists; `HumanInTheLoop` for restricted client actions. | Coordinates the request, uses returned results, and reports the observed outcome. |
| Materials Planner | `get_engineering_plan_context`, `search_catalog`, `search_inventory`, and validated structured output. | Required catalog parts and quantities; read-only. |
| Inventory Auditor | `get_latest_inventory_audit`, `get_inventory_audit_history`, `MemoryManager`; `run_inventory_audit` only when trusted server code enables execution. | Audit explanation and historical context; scoped execution in trusted internal mode. |
| Vision Analyst | Strands `Agent` + GoogleModel + `GoalLoop`; no warehouse-action tools. | Image count, identity, and foreign-object evidence. |
| Vision Judge | Separate Strands `Agent` + GoogleModel + typed evaluation; invoked for qualifying proposals. | Independent support/rejection of the proposed image observation. |

The last two roles are implemented in
[geminiAuditCount.ts](../src/lib/geminiAuditCount.ts). GoalLoop refinement
reuses image bytes; motion, capture, persistence, and inventory decisions
remain outside those agents.

The Coordinator → Planner and Coordinator → Auditor routes are alternatives
selected for the task, not an unconditional chain. The plan-analysis service
calls the Planner and audit workflow directly; it does not need the Warehouse
Agent or Auditor language agent. The exact three-bin SIMULATION scenario can
also bypass the Planner using server-grounded scripted requirements.

## Judging lens and implementation evidence

The five criteria below have equal weight under the
[official judging rules](https://agentsforhumans.devpost.com/rules).
The evidence column identifies implementation, not a guaranteed score.

| Criterion | What RackHand should demonstrate | Source-code evidence |
| --- | --- | --- |
| Technical Implementation | Real SDK agents, scoped delegation, typed outputs, approval interventions, guarded graphs, and lifecycle tracing. | [Warehouse agent](../src/lib/agents/warehouse-agent.ts), [Materials Planner](../src/lib/agents/materials-planner-agent.ts), [Inventory Auditor](../src/lib/agents/inventory-auditor-agent.ts), [retrieval graph](../src/lib/warehouse/graphs/retrieval-graph.ts), [putaway graph](../src/lib/warehouse/graphs/putaway-graph.ts), [audit graph](../src/lib/warehouse/graphs/inventory-audit-graph.ts), [tracing hooks](../src/lib/observability/strands-hooks.ts). |
| Design | One coherent journey: request or plan → checked bins → return → stock/readiness report, with clear exceptions. | [Fulfillment service](../src/lib/warehouse/materials-fulfillment-service.ts), [plan analysis](../src/lib/engineering-plan/analysis-service.ts). |
| Potential Impact | Engineers and small assembly teams spend less effort searching and recounting; shortages are visible before work starts. Present this as intended benefit, not measured savings. | [Verification freshness](../src/lib/warehouse/bin-verification-evidence.ts), [physical availability](../src/lib/engineering-plan/physical-availability.ts). |
| Creativity & Originality | Connect natural-language preparation, evidence freshness, camera inspection, scale checks, and bin-state workflows instead of stopping at a chat answer. | [Shared inspection](../src/lib/warehouse/bin-inspection-service.ts), [physical verification](../src/lib/warehouse/putaway-verification.ts). |
| Presentation | Show a complete success and a meaningful exception; explain exactly what is simulated and what the production path implements. | [Explicit browser scenario](../src/lib/warehouse/control-module-scenario.ts), [Pi setup](../hardware/warehouse-camera/README.md). |

## Important boundaries for an honest demo

- Gantry movement is simulated and process-local; no real motor controller is
  implemented.
- The explicit control-module SIMULATION scenario uses scripted images and
  inspection results. It is not evidence that live Gemini or a physical scale
  counted those items.
- The production capture path supports Pi camera/scale evidence and Gemini
  inspection. Hardware connectivity and deployed availability were not verified
  in this documentation review.
- Plan analysis is user-triggered. It selects audits internally, but there is
  no scheduled unattended auditing service to claim.
- Interactive retrieve/return checks automatically reconcile trusted counts;
  uncertain contents require attention. Plan audits use a report-only review
  policy, so do not present them as the same remove/retry interaction.
- A trusted check expires at seven days. Changed, missing, or unresolved
  evidence also requires checking; a recent unchanged check can be reused.
- Do not claim engineer email/chat notification unless a real delivery
  integration is demonstrated. Reporting an issue in the UI is not delivery.
- Source inspection supports the architecture claims; it does not establish
  eligibility, public-repository visibility, or submission completeness.

## Suggested demo story

Start with the engineer's problem and audience. Show the agentic loop briefly,
then spend most of the demo on the product's observed behavior:

1. Prepare the control-module parts using already stocked demo bins. Disclose
   simulation on screen. Show a matching count, a trusted mismatch correction,
   an unexpected-object retry, verified remainders, and all bins returned.
2. Analyze upcoming work. Explain the check reason, such as evidence at least
   seven days old. Show the final ready/not-ready decision and any shortage.
3. If demonstrating production camera/scale verification, switch explicitly
   to PROD and show the fresh capture and real scale reading; do not substitute
   the scripted scenario as proof.

Before submitting, verify the public repository/license, video URL, testing
instructions, actual track selection, and Builder ID in Devpost. This change
does not publish files, alter the Devpost entry, or deploy AWS services.
