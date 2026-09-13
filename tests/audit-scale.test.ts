import { describe, expect, it } from "vitest";
import { checkAuditScale } from "@/lib/warehouse/audit-scale";

const baseline = { unitWeightGrams: 5, tareWeightGrams: 117, weightSource: "SCALE" };
const reading = { totalWeightGrams: 167, weightSource: "SCALE" };
describe("audit camera and scale comparison", () => {
  it("supports a camera observation of 10 against a 10-item physical reading", () => {
    expect(checkAuditScale(10, reading, baseline)).toEqual({ status: "AGREES", totalWeightGrams: 167, estimatedQuantity: 10 });
  });
  it("flags a camera count of 12 against the weight of 10 without overwriting the count", () => {
    expect(checkAuditScale(12, reading, baseline).status).toBe("MISMATCH");
  });
  it("never treats fallback totals or fallback item weights as scale evidence", () => {
    expect(checkAuditScale(10, { ...reading, weightSource: "FALLBACK" }, baseline).status).toBe("UNAVAILABLE");
    expect(checkAuditScale(10, reading, { ...baseline, weightSource: "FALLBACK" }).status).toBe("UNAVAILABLE");
  });
  it("requires a known item weight and a physical reading", () => {
    expect(checkAuditScale(10, reading, null).status).toBe("UNAVAILABLE");
    expect(checkAuditScale(10, {}, baseline).status).toBe("UNAVAILABLE");
  });
  it("handles sensor rounding and an empty bin", () => {
    expect(checkAuditScale(10, { ...reading, totalWeightGrams: 167.1 }, baseline).status).toBe("AGREES");
    expect(checkAuditScale(0, { ...reading, totalWeightGrams: 117 }, baseline).status).toBe("AGREES");
  });
});
