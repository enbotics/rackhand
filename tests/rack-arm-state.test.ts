import { describe, expect, it } from "vitest";
import type { InventoryAuditView } from "@/lib/warehouse/dashboard-types";
import {
  deriveRackArmState,
  gantryStatusFromAuditMovement,
} from "@/lib/warehouse/rack-arm-state";

function auditWithPhase(
  movementPhase: "TO_SCAN" | "AT_SCAN" | "RETURNING",
  movementPhaseStartedAt = 10_000,
): InventoryAuditView {
  return {
    auditRunId: "audit-run-1",
    trigger: "TRUSTED_INTERNAL",
    status: "RUNNING",
    requestedBinCode: "B4-01",
    binsPlanned: 1,
    binsCompleted: 0,
    verifiedBins: 0,
    reconciledBins: 0,
    reviewRequiredBins: 0,
    failedBins: 0,
    startedAt: movementPhaseStartedAt,
    completedAt: null,
    bins: [{
      captureMode: "SIMULATION",
      binAuditId: "bin-audit-1",
      binCode: "B4-01",
      sku: "HARDWARE-V-GROOVE-WHEEL-KIT",
      status: "RUNNING",
      movementPhase,
      movementPhaseStartedAt,
      expectedQuantity: 10,
      observedQuantity: null,
      confidencePercent: null,
      inventoryUpdated: false,
      previousQuantity: 10,
      newQuantity: null,
      evidenceUrl: null,
      priorEvidenceUrl: null,
      awaitingConfirmation: false,
      canApply: false,
      reason: null,
    }],
  };
}

describe("durable audit movement playback", () => {
  it("shows B4-01 travelling from its shelf to the checkout station", () => {
    const gantry = gantryStatusFromAuditMovement(auditWithPhase("TO_SCAN"), 13_000);

    expect(gantry).toMatchObject({
      mode: "SIMULATION",
      state: "MOVING",
      currentLocation: "B4-01",
      carrying: true,
      operation: {
        type: "AUDIT_PRESENTATION",
        source: "B4-01",
        destination: "SCAN_STATION",
        status: "RUNNING",
      },
      motion: { from: "B4-01", to: "SCAN_STATION" },
    });
    expect(deriveRackArmState({ gantry, activeMovement: null, latestAudit: null })).toMatchObject({
      carrying: true,
      focusBin: "B4-01",
      route: { from: "B4-01", to: "SCAN_STATION" },
    });
  });

  it("keeps B4-01 at checkout while its scan is running", () => {
    expect(gantryStatusFromAuditMovement(auditWithPhase("AT_SCAN"), 20_000)).toMatchObject({
      state: "IDLE",
      currentLocation: "SCAN_STATION",
      carrying: false,
      operation: {
        type: "AUDIT_PRESENTATION",
        destination: "SCAN_STATION",
        status: "COMPLETED",
      },
    });
  });

  it("shows B4-01 travelling back to the same shelf slot", () => {
    const gantry = gantryStatusFromAuditMovement(auditWithPhase("RETURNING"), 13_000);

    expect(gantry).toMatchObject({
      state: "MOVING",
      currentLocation: "SCAN_STATION",
      carrying: true,
      operation: {
        type: "AUDIT_RETURN",
        source: "SCAN_STATION",
        destination: "B4-01",
        status: "RUNNING",
      },
      motion: { from: "SCAN_STATION", to: "B4-01" },
    });
  });

  it("shows the empty carriage homing only after the bin is put back", () => {
    expect(gantryStatusFromAuditMovement(auditWithPhase("RETURNING"), 15_200)).toMatchObject({
      state: "HOMING",
      currentLocation: "B4-01",
      carrying: false,
      motion: { from: "B4-01", to: null },
    });
  });
});
