import { describe, expect, it } from "vitest";
import {
  ENGINEERING_PLAN_HEADERS,
  OPERATIONAL_PLAN_HEADERS,
  findEngineeringPlanRows,
  findTodayEngineeringPlanRows,
  parseEngineeringPlanValues,
  tomorrowEngineeringPlanWorkDate,
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

  const operationalValues = [
    [...OPERATIONAL_PLAN_HEADERS],
    [
      "WO-CM-104", "2026-09-13", "PREPARE", "1", "Control Module",
      "V-groove bearing wheel hardware kit", "B4-01", "1", "ea", "4",
      "HIGH", "NO", "NO", "YES", "RELEASED",
    ],
    [
      "WO-CM-104", "2026-09-13", "PREPARE", "2", "Control Module",
      "Makerbase MKS TMC2160-OC V1.0 stepper motor driver", "B3-03", "1", "kit", "12",
      "HIGH", "NO", "NO", "YES", "RELEASED",
    ],
    [
      "WO-CM-104", "2026-09-13", "PREPARE", "3", "Control Module",
      "Round unthreaded spacer", "B6-03", "4", "ea", "20",
      "HIGH", "NO", "NO", "YES", "RELEASED",
    ],
    [
      "WO-SA-219", "2026-09-14", "MONITOR", "1", "Sensor Array",
      "Sensor modules", "B6-03", "19", "ea", "20",
      "STOP_WORK", "NO", "NO", "NO", "PLANNED",
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

  it("selects tomorrow across month and year boundaries", () => {
    expect(tomorrowEngineeringPlanWorkDate("2026-09-13")).toBe("2026-09-14");
    expect(tomorrowEngineeringPlanWorkDate("2026-12-31")).toBe("2027-01-01");
  });

  it("parses every released PREPARE row from the operational plan layout", () => {
    const rows = parseEngineeringPlanValues(operationalValues);

    expect(rows).toHaveLength(3);
    expect(rows.map((row) => row.planId)).toEqual([
      "WO-CM-104-1",
      "WO-CM-104-2",
      "WO-CM-104-3",
    ]);
    expect(rows.map((row) => [row.materialHints, row.quantityScale])).toEqual([
      ["V-groove bearing wheel hardware kit", "1 ea"],
      ["Makerbase MKS TMC2160-OC V1.0 stepper motor driver", "1 kit"],
      ["Round unthreaded spacer", "4 ea"],
    ]);
  });

  it("returns all operational rows matching the control module request", () => {
    const matches = findEngineeringPlanRows(
      parseEngineeringPlanValues(operationalValues),
      "RackHand, prep the parts for the control module.",
    );

    expect(matches.map((row) => row.planId)).toEqual([
      "WO-CM-104-1",
      "WO-CM-104-2",
      "WO-CM-104-3",
    ]);
  });
});
