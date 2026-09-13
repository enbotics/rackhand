import { describe, expect, it } from "vitest";
import { classifyBinVerificationEvidence } from "@/lib/warehouse/bin-verification-evidence";

const at = (iso: string) => new Date(iso);

describe("bin verification evidence", () => {
  it("keeps a verified putaway current at the completion of its own movement", () => {
    const evidence = classifyBinVerificationEvidence({
      binCode: "B1-01",
      latestAudit: null,
      latestDestinationMovement: {
        type: "PUTAWAY",
        createdAt: at("2026-09-12T10:00:00.000Z"),
        completedAt: at("2026-09-12T10:01:00.000Z"),
        verificationCapturedAt: at("2026-09-12T10:00:30.000Z"),
        verificationImageUrl: "private://putaway.jpg",
      },
      latestSourceMovement: null,
    });

    expect(evidence).toMatchObject({ state: "TRUSTED", trusted: true });
    expect(evidence.lastVerifiedAt).toBe("2026-09-12T10:00:30.000Z");
  });

  it("invalidates accepted evidence after a later inventory-changing event", () => {
    const evidence = classifyBinVerificationEvidence({
      binCode: "B1-01",
      latestAudit: {
        status: "VERIFIED",
        createdAt: at("2026-09-12T08:00:00.000Z"),
        capturedAt: at("2026-09-12T08:01:00.000Z"),
        completedAt: at("2026-09-12T08:02:00.000Z"),
      },
      latestDestinationMovement: {
        type: "ADJUSTMENT",
        createdAt: at("2026-09-12T09:00:00.000Z"),
        completedAt: at("2026-09-12T09:00:00.000Z"),
        verificationCapturedAt: null,
        verificationImageUrl: null,
      },
      latestSourceMovement: null,
    });

    expect(evidence).toMatchObject({
      state: "CHANGED_AFTER_VERIFICATION",
      trusted: false,
    });
  });

  it("expires unchanged evidence at seven days so plan analysis audits it", () => {
    const evidence = classifyBinVerificationEvidence({
      binCode: "B1-01",
      latestAudit: {
        status: "CONFIRMED",
        createdAt: at("2025-01-01T00:00:00.000Z"),
        capturedAt: at("2025-01-01T00:01:00.000Z"),
        completedAt: at("2025-01-01T00:02:00.000Z"),
      },
      latestDestinationMovement: null,
      latestSourceMovement: null,
    }, at("2025-01-08T00:02:00.000Z"));

    expect(evidence).toMatchObject({
      state: "VERIFICATION_EXPIRED",
      trusted: false,
      lastVerifiedAt: "2025-01-01T00:02:00.000Z",
      reason: "latest trusted verification from 2025-01-01 is 7 days old",
    });
  });

  it("keeps unchanged evidence trusted immediately before seven days", () => {
    const evidence = classifyBinVerificationEvidence({
      binCode: "B1-01",
      latestAudit: {
        status: "CONFIRMED",
        createdAt: at("2025-01-01T00:00:00.000Z"),
        capturedAt: at("2025-01-01T00:01:00.000Z"),
        completedAt: at("2025-01-01T00:02:00.000Z"),
      },
      latestDestinationMovement: null,
      latestSourceMovement: null,
    }, at("2025-01-08T00:01:59.999Z"));

    expect(evidence).toMatchObject({ state: "TRUSTED", trusted: true });
  });
});
