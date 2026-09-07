/**
 * Local stack smoke test — `npm run test:smoke`.
 *
 * Answers one question in a few seconds: is this machine's copy of the system
 * wired up? Database reachable, migrations applied, bins seeded, simulator
 * IDLE, agent constructible, every critical service importable.
 *
 * DELIBERATELY OFFLINE. It calls no model and no external API, so it works on
 * a plane and cannot fail because Bedrock is having a bad morning. Proving the
 * model picks the right tool is `npm run agent:smoke`, which does cost money.
 *
 * Read-only: it creates no Movement, no inventory and no gantry operation.
 * Safe to run against the demo database.
 */
import "./load-env";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../src/generated/prisma/client";
import { SEED_BIN_CODES } from "../src/lib/warehouse/types";

interface Check {
  label: string;
  run: () => Promise<string>;
}

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error("DATABASE_URL is not set — see .env.local (Supabase pooled connection string).");
}
const adapter = new PrismaPg(databaseUrl);
const prisma = new PrismaClient({ adapter });

/** Redacts the password before printing a connection string to the console. */
function redactUrl(url: string): string {
  return url.replace(/:\/\/([^:]+):[^@]+@/, "://$1:***@");
}

const CHECKS: Check[] = [
  {
    label: "database reachable",
    run: async () => {
      await prisma.$queryRaw`SELECT 1`;
      return redactUrl(databaseUrl);
    },
  },
  {
    label: "schema applied (every table queryable)",
    run: async () => {
      const counts = {
        parts: await prisma.part.count(),
        bins: await prisma.bin.count(),
        inventory: await prisma.inventory.count(),
        movements: await prisma.movement.count(),
        approvals: await prisma.actionApproval.count(),
        resolutions: await prisma.catalogResolution.count(),
        traces: await prisma.agentTrace.count(),
      };
      return Object.entries(counts)
        .map(([name, count]) => `${name}=${count}`)
        .join(" ");
    },
  },
  {
    label: "bins seeded",
    run: async () => {
      const bins = await prisma.bin.findMany({ orderBy: { code: "asc" } });
      const codes = bins.map((bin) => bin.code);
      const missing = SEED_BIN_CODES.filter((code) => !codes.includes(code));
      if (missing.length > 0) {
        throw new Error(`missing ${missing.join(", ")} — run \`npm run db:seed\``);
      }
      return bins.map((bin) => `${bin.code}:${bin.status}`).join(" ");
    },
  },
  {
    label: "gantry simulator IDLE",
    run: async () => {
      const { getGantryController, getGantryMode } = await import("../src/lib/gantry/factory");
      const status = await getGantryController().getStatus();
      if (status.mode !== "SIMULATION") throw new Error(`mode is ${status.mode}`);
      if (status.state !== "IDLE") throw new Error(`state is ${status.state}`);
      return `${getGantryMode()} ${status.state} homed=${status.homed}`;
    },
  },
  {
    label: "critical services import",
    run: async () => {
      const modules = [
        "../src/lib/warehouse/putaway-service",
        "../src/lib/warehouse/retrieval-service",
        "../src/lib/warehouse/catalog-matcher",
        "../src/lib/warehouse/catalog-resolution-service",
        "../src/lib/warehouse/graphs/putaway-graph",
        "../src/lib/warehouse/graphs/retrieval-graph",
        "../src/lib/observability/trace-service",
      ];
      await Promise.all(modules.map((path) => import(path)));
      return `${modules.length} modules`;
    },
  },
  {
    label: "Strands graphs build",
    run: async () => {
      const { getPutawayGraph } = await import("../src/lib/warehouse/graphs/putaway-graph");
      const { getRetrievalGraph } = await import("../src/lib/warehouse/graphs/retrieval-graph");
      const { PUTAWAY_NODE_ORDER, RETRIEVAL_NODE_ORDER } = await import(
        "../src/lib/warehouse/graphs/workflow-types"
      );
      getPutawayGraph();
      getRetrievalGraph();
      return (
        `putaway ${PUTAWAY_NODE_ORDER.length} nodes, ` +
        `retrieval ${RETRIEVAL_NODE_ORDER.length} nodes`
      );
    },
  },
  {
    label: "agent constructible with the approved tool list",
    run: async () => {
      // No credential and no network: constructing the agent proves the wiring,
      // not that a model will answer.
      const { createWarehouseAgent } = await import("../src/lib/agents/warehouse-agent");
      const { WAREHOUSE_AGENT_TOOL_NAMES } = await import("../src/lib/agents/tools");
      createWarehouseAgent();
      return `${WAREHOUSE_AGENT_TOOL_NAMES.length} tools: ${WAREHOUSE_AGENT_TOOL_NAMES.join(", ")}`;
    },
  },
];

async function main(): Promise<void> {
  console.log("Warehouse stack smoke test (offline — no model calls)\n");

  let failed = 0;
  for (const check of CHECKS) {
    try {
      const detail = await check.run();
      console.log(`  PASS  ${check.label}\n        ${detail}`);
    } catch (err) {
      failed += 1;
      console.log(`  FAIL  ${check.label}\n        ${err instanceof Error ? err.message : err}`);
    }
  }

  await prisma.$disconnect();

  console.log(
    failed === 0
      ? `\nAll ${CHECKS.length} checks passed.`
      : `\n${failed} of ${CHECKS.length} checks FAILED.`,
  );
  process.exit(failed === 0 ? 0 : 1);
}

main().catch(async (err) => {
  console.error(err);
  await prisma.$disconnect();
  process.exit(1);
});
