export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs" && process.env.ENGINEERING_PLAN_AUTO_ENABLED === "true"
    && process.env.NEXT_PHASE !== "phase-production-build") {
    const { startAutomaticPlanCoordinator } = await import("@/lib/engineering-plan/auto-coordinator");
    startAutomaticPlanCoordinator();
  }
}
