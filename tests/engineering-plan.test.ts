import { describe, expect, it } from "vitest";
import {
  ENGINEERING_PLAN_HEADERS,
  findEngineeringPlanRows,
  parseEngineeringPlanValues,
} from "@/lib/engineering-plan/google-sheets";

describe("engineering plan Google Sheet", () => {
  const values = [
    [...ENGINEERING_PLAN_HEADERS],
    [
      "EXAMPLE-001", "2026-09-14", "Example", "Demo Workbench",
      "Build a mobile assembly workbench", "Frame", "Cut timber", "wood screws",
      "1", "850 mm doorway", "Planned", "High", "No", "2026-09-12",
    ],
    [
      "PLAN-101", "2026-09-14", "Mara", "Mobile Workbench",
      "Build a mobile assembly workbench", "Prepare frame", "Cut and assemble timber",
      "wood screws; corner brackets", "1 workbench", "850 mm doorway", "In Progress",
      "High", "Yes", "2026-09-12",
    ],
    [
      "PLAN-102", "2026-09-15", "Mara", "Mobile Workbench",
      "Build a mobile assembly workbench", "Install wheels", "Mount locking casters",
      "bolts; washers", "4 casters", "250 kg load", "Planned", "High", "Yes", "2026-09-12",
    ],
  ];

  it("accepts enabled real rows and excludes template examples", () => {
    const rows = parseEngineeringPlanValues(values);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ planId: "PLAN-101", engineer: "Mara" });
  });

  it("returns the matching day-by-day project without unrelated rows", () => {
    const matches = findEngineeringPlanRows(
      parseEngineeringPlanValues(values),
      "I am building the mobile assembly workbench",
    );
    expect(matches.map((row) => row.planId)).toEqual(["PLAN-101", "PLAN-102"]);
  });

  it("does not substitute an unrelated plan when the prompt has no match", () => {
    expect(findEngineeringPlanRows(parseEngineeringPlanValues(values), "solar bicycle")).toEqual([]);
  });
});
