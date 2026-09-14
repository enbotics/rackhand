import path from "node:path";
import { defineConfig } from "vitest/config";

/** Read-only/unit verification checks; no migrations or live warehouse database. */
export default defineConfig({
  test: {
    environment: "node",
    include: [
      "tests/putaway-weight.test.ts",
      "tests/putaway-confidence-policy.test.ts",
      "tests/audit-capture-dialog.test.tsx",
      "tests/user-bin-verification.test.ts",
      "tests/physical-capture-verification.test.ts",
      "tests/retrieval-graph-timeout.test.ts",
      "tests/approval-card-auto-return.test.tsx",
      "tests/control-module-scenario.test.ts",
      "tests/control-module-tools.test.ts",
      "tests/materials-plan-pipeline-card.test.ts",
    ],
    env: { DATABASE_URL: "postgresql://test-warehouse:test-warehouse@127.0.0.1:5432/test-warehouse" },
    fileParallelism: false,
  },
  resolve: { alias: { "@": path.resolve(import.meta.dirname, "src") } },
});
