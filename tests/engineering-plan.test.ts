import { describe, expect, it } from "vitest";
import {
  ENGINEERING_PLAN_HEADERS,
  findEngineeringPlanRows,
  findTodayEngineeringPlanRows,
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

  it("selects only enabled rows scheduled for the exact warehouse work date", () => {
    const matches = findTodayEngineeringPlanRows(
      parseEngineeringPlanValues(values),
      "2026-09-14",
    );
    expect(matches.map((row) => row.planId)).toEqual(["PLAN-101"]);
  });

  it("matches a work date even when Sheets renders it as unpadded US M/D/YYYY", () => {
    const usFormatted = [
      [...ENGINEERING_PLAN_HEADERS],
      [
        "PLAN-201", "9/9/2026", "Mara", "Tabletop Enclosure",
        "Build a small aluminum enclosure", "Assemble frame", "Join corners",
        "aluminum extrusion connectors", "4", "None", "In Progress", "High", "Yes", "2026-09-09",
      ],
    ];
    const matches = findTodayEngineeringPlanRows(
      parseEngineeringPlanValues(usFormatted),
      "2026-09-09",
    );
    expect(matches.map((row) => row.planId)).toEqual(["PLAN-201"]);
  });
});
