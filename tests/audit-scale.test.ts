import { describe, expect, it } from "vitest";
import { checkAuditScale } from "@/lib/warehouse/audit-scale";

const reading = { totalWeightGrams: 122.6, weightSource: "SCALE" };
describe("audit scale-based quantity", () => {
  it("counts ten sensor modules using their supplied 1.56 g weight", () => {
    expect(checkAuditScale(reading, 1.56)).toEqual({
      status: "VERIFIED", totalWeightGrams: 122.6, estimatedQuantity: 10,
    });
  });
  it("requires a supplied weight and physical scale reading", () => {
    expect(checkAuditScale(reading, null).status).toBe("UNAVAILABLE");
    expect(checkAuditScale({}, 1.56).status).toBe("UNAVAILABLE");
    expect(checkAuditScale({ ...reading, weightSource: "FALLBACK" }, 1.56).status).toBe("UNAVAILABLE");
  });
  it("rejects an ambiguous quantity and below-tare readings", () => {
    expect(checkAuditScale({ ...reading, totalWeightGrams: 123.38 }, 1.56)).toMatchObject({
      status: "MISMATCH", estimatedQuantity: null,
    });
    expect(checkAuditScale({ ...reading, totalWeightGrams: 100 }, 1.56).status).toBe("UNAVAILABLE");
  });
  it("supports sensor rounding and an empty bin", () => {
    expect(checkAuditScale({ ...reading, totalWeightGrams: 122.7 }, 1.56).estimatedQuantity).toBe(10);
    expect(checkAuditScale({ ...reading, totalWeightGrams: 107 }, 1.56).estimatedQuantity).toBe(0);
  });
});
