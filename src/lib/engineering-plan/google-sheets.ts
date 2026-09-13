import { GoogleAuth } from "google-auth-library";

export const ENGINEERING_PLAN_HEADERS = [
  "Plan ID",
  "Work Date",
  "Engineer",
  "Project",
  "Build / Task",
  "Day Objective",
  "Planned Work",
  "Material Hints",
  "Quantity / Scale",
  "Constraints",
  "Status",
  "Priority",
  "Include for Agent",
  "Last Updated",
] as const;

/** Row-per-part operational plan exported by the team's current Sheet table. */
export const OPERATIONAL_PLAN_HEADERS = [
  "work_order_id",
  "work_date",
  "agent_mode",
  "sequence",
  "assembly_task",
  "part_name",
  "bin_id",
  "required_qty",
  "unit",
  "software_on_hand_qty",
  "criticality",
  "substitute_allowed",
  "partial_build_allowed",
  "approval_required",
  "plan_status",
] as const;

export interface EngineeringPlanRow {
  planId: string;
  workDate: string;
  engineer: string;
  project: string;
  buildTask: string;
  dayObjective: string;
  plannedWork: string;
  materialHints: string;
  quantityScale: string;
  constraints: string;
  status: string;
  priority: string;
  lastUpdated: string;
}

export interface EngineeringPlanContext {
  configured: boolean;
  query: string;
  currentWorkDate: string;
  matchCount: number;
  rows: EngineeringPlanRow[];
  reason?: "not_configured" | "unavailable" | "no_match";
}

const HEADER_KEYS: Record<(typeof ENGINEERING_PLAN_HEADERS)[number], keyof EngineeringPlanRow | "include"> = {
  "Plan ID": "planId",
  "Work Date": "workDate",
  Engineer: "engineer",
  Project: "project",
  "Build / Task": "buildTask",
  "Day Objective": "dayObjective",
  "Planned Work": "plannedWork",
  "Material Hints": "materialHints",
  "Quantity / Scale": "quantityScale",
  Constraints: "constraints",
  Status: "status",
  Priority: "priority",
  "Include for Agent": "include",
  "Last Updated": "lastUpdated",
};

const SEARCH_STOP_WORDS = new Set([
  "a", "am", "an", "and", "are", "build", "building", "for", "i", "in", "is", "it",
  "make", "making", "my", "of", "on", "project", "the", "to", "today", "want", "what",
]);

function text(value: unknown): string {
  return typeof value === "string" || typeof value === "number" ? String(value).trim().slice(0, 500) : "";
}

function headerPositions(rawHeaders: unknown[]): Map<string, number> {
  const positions = new Map<string, number>();
  rawHeaders.forEach((header, index) => positions.set(text(header), index));
  return positions;
}

function parseLegacyPlanRows(
  positions: Map<string, number>,
  rawRows: unknown[][],
): EngineeringPlanRow[] {
  if (!ENGINEERING_PLAN_HEADERS.every((header) => positions.has(header))) return [];

  return rawRows.flatMap((row) => {
    const record: Record<string, string> = {};
    for (const header of ENGINEERING_PLAN_HEADERS) {
      record[HEADER_KEYS[header]] = text(row[positions.get(header)!]);
    }
    if (record.include.toLowerCase() !== "yes" || record.planId.startsWith("EXAMPLE-")) return [];
    if (!record.planId || !record.project || !record.buildTask) return [];
    return [{
      planId: record.planId,
      workDate: record.workDate,
      engineer: record.engineer,
      project: record.project,
      buildTask: record.buildTask,
      dayObjective: record.dayObjective,
      plannedWork: record.plannedWork,
      materialHints: record.materialHints,
      quantityScale: record.quantityScale,
      constraints: record.constraints,
      status: record.status,
      priority: record.priority,
      lastUpdated: record.lastUpdated,
    }];
  });
}

function parseOperationalPlanRows(
  positions: Map<string, number>,
  rawRows: unknown[][],
): EngineeringPlanRow[] {
  if (!OPERATIONAL_PLAN_HEADERS.every((header) => positions.has(header))) return [];
  const value = (row: unknown[], header: (typeof OPERATIONAL_PLAN_HEADERS)[number]) =>
    text(row[positions.get(header)!]);

  return rawRows.flatMap((row) => {
    const workOrderId = value(row, "work_order_id");
    const workDate = value(row, "work_date");
    const mode = value(row, "agent_mode").toUpperCase();
    const sequence = value(row, "sequence");
    const assemblyTask = value(row, "assembly_task");
    const partName = value(row, "part_name");
    const requiredQuantity = value(row, "required_qty");
    const unit = value(row, "unit");
    const criticality = value(row, "criticality");
    const planStatus = value(row, "plan_status").toUpperCase();

    if (mode !== "PREPARE" || planStatus !== "RELEASED") return [];
    if (!workOrderId || !workDate || !assemblyTask || !partName || !requiredQuantity) return [];

    const constraints = [
      `Substitute allowed: ${value(row, "substitute_allowed") || "unspecified"}`,
      `Partial build allowed: ${value(row, "partial_build_allowed") || "unspecified"}`,
      `Approval required: ${value(row, "approval_required") || "unspecified"}`,
    ].join("; ");

    return [{
      planId: sequence ? `${workOrderId}-${sequence}` : workOrderId,
      workDate,
      engineer: "",
      project: assemblyTask,
      buildTask: assemblyTask,
      dayObjective: `Prepare ${assemblyTask}`,
      plannedWork: `Prepare ${partName}`,
      materialHints: partName,
      quantityScale: `${requiredQuantity}${unit ? ` ${unit}` : ""}`,
      constraints,
      status: planStatus,
      priority: criticality,
      lastUpdated: "",
    }];
  });
}

/** Convert either supported Sheet layout into the planner's stable row shape. */
export function parseEngineeringPlanValues(values: unknown[][]): EngineeringPlanRow[] {
  const [rawHeaders, ...rawRows] = values;
  if (!rawHeaders) return [];
  const positions = headerPositions(rawHeaders);
  return parseLegacyPlanRows(positions, rawRows).concat(
    parseOperationalPlanRows(positions, rawRows),
  );
}

function tokens(value: string): string[] {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .split(" ")
    .filter((token) => token.length > 1 && !SEARCH_STOP_WORDS.has(token));
}

/** Rank only explicit project/build matches; an unrelated plan is worse than no context. */
export function findEngineeringPlanRows(
  rows: EngineeringPlanRow[],
  query: string,
  limit = 12,
): EngineeringPlanRow[] {
  const queryTokens = [...new Set(tokens(query))];
  if (queryTokens.length === 0) return [];
  return rows
    .map((row) => {
      const project = `${row.project} ${row.buildTask}`.toLowerCase();
      const detail = `${row.dayObjective} ${row.plannedWork} ${row.materialHints}`.toLowerCase();
      const score = queryTokens.reduce(
        (total, token) => total + (project.includes(token) ? 4 : detail.includes(token) ? 1 : 0),
        0,
      );
      return { row, score };
    })
    .filter(({ score }) => score > 0)
    .sort((left, right) => right.score - left.score || left.row.workDate.localeCompare(right.row.workDate))
    .slice(0, limit)
    .map(({ row }) => row);
}

/**
 * Sheets returns a Date-formatted cell as displayed, not as entered — this
 * spreadsheet's own "Work Date" column renders as US "M/D/YYYY" (unpadded),
 * never the ISO "YYYY-MM-DD" currentEngineeringPlanWorkDate() produces. A
 * live check against the real sheet found a strict string match between
 * those two forms silently missed every real row, every day, project-wide.
 * Normalizing both sides here — rather than changing what
 * currentEngineeringPlanWorkDate() emits — is what stays correct if the
 * sheet's own locale/number-format ever changes back to ISO.
 *
 * Returns null for anything unrecognized: an unparseable date must never be
 * coerced into matching today by accident.
 */
function normalizeWorkDate(value: string): string | null {
  const trimmed = value.trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) return trimmed;
  const us = trimmed.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (!us) return null;
  const [, month, day, year] = us;
  return `${year}-${month.padStart(2, "0")}-${day.padStart(2, "0")}`;
}

/** Exact work-date selection for event/manual analysis; no fuzzy fallback. */
export function findTodayEngineeringPlanRows(
  rows: EngineeringPlanRow[],
  workDate: string,
  limit = 24,
): EngineeringPlanRow[] {
  return rows
    .filter((row) => normalizeWorkDate(row.workDate) === workDate)
    .sort(
      (left, right) =>
        left.priority.localeCompare(right.priority) || left.planId.localeCompare(right.planId),
    )
    .slice(0, limit);
}

function sheetsConfig() {
  const spreadsheetId = process.env.ENGINEERING_PLAN_SPREADSHEET_ID?.trim();
  const range = process.env.ENGINEERING_PLAN_SHEET_RANGE?.trim() || "UpdatedPlan!A1:O250";
  return spreadsheetId ? { spreadsheetId, range } : null;
}

export function currentEngineeringPlanWorkDate(): string {
  const timeZone = process.env.ENGINEERING_PLAN_TIME_ZONE?.trim() || "UTC";
  try {
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).formatToParts(new Date());
    const part = (type: Intl.DateTimeFormatPartTypes) =>
      parts.find((candidate) => candidate.type === type)?.value ?? "";
    return `${part("year")}-${part("month")}-${part("day")}`;
  } catch {
    return new Date().toISOString().slice(0, 10);
  }
}

async function authorizationHeader(): Promise<string | null> {
  const clientEmail = process.env.GOOGLE_SERVICE_ACCOUNT_CLIENT_EMAIL?.trim();
  const privateKey = process.env.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY?.replace(/\\n/g, "\n");
  const credentials = clientEmail && privateKey
    ? { client_email: clientEmail, private_key: privateKey }
    : undefined;
  if (!credentials && !process.env.GOOGLE_APPLICATION_CREDENTIALS) return null;
  const auth = new GoogleAuth({
    credentials,
    scopes: ["https://www.googleapis.com/auth/spreadsheets.readonly"],
  });
  const token = await auth.getAccessToken();
  return token ? `Bearer ${token}` : null;
}

async function readEngineeringPlanRows(): Promise<{
  configured: boolean;
  currentWorkDate: string;
  rows: EngineeringPlanRow[];
  reason?: "not_configured" | "unavailable";
}> {
  const config = sheetsConfig();
  const workDate = currentEngineeringPlanWorkDate();
  if (!config) {
    return { configured: false, currentWorkDate: workDate, rows: [], reason: "not_configured" };
  }

  try {
    const authorization = await authorizationHeader();
    const apiKey = process.env.GOOGLE_SHEETS_API_KEY?.trim();
    if (!authorization && !apiKey) {
      return { configured: false, currentWorkDate: workDate, rows: [], reason: "not_configured" };
    }
    const url = new URL(
      `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(config.spreadsheetId)}/values/${encodeURIComponent(config.range)}`,
    );
    if (apiKey) url.searchParams.set("key", apiKey);
    const response = await fetch(url, {
      headers: authorization ? { Authorization: authorization } : undefined,
      cache: "no-store",
      signal: AbortSignal.timeout(8_000),
    });
    if (!response.ok) throw new Error(`Sheets returned ${response.status}`);
    const payload = (await response.json()) as { values?: unknown[][] };
    return {
      configured: true,
      currentWorkDate: workDate,
      rows: parseEngineeringPlanValues(payload.values ?? []),
    };
  } catch (error) {
    console.error("[engineering-plan] Google Sheets read failed:", error);
    return { configured: true, currentWorkDate: workDate, rows: [], reason: "unavailable" };
  }
}

/** Read-only, bounded Google Sheets lookup used by the Materials Planner. */
export async function getEngineeringPlanContext(query: string): Promise<EngineeringPlanContext> {
  const sheet = await readEngineeringPlanRows();
  if (sheet.reason) {
    return {
      configured: sheet.configured,
      query,
      currentWorkDate: sheet.currentWorkDate,
      matchCount: 0,
      rows: [],
      reason: sheet.reason,
    };
  }
  const matches = findEngineeringPlanRows(sheet.rows, query);
  return {
    configured: true,
    query,
    currentWorkDate: sheet.currentWorkDate,
    matchCount: matches.length,
    rows: matches,
    ...(matches.length === 0 ? { reason: "no_match" as const } : {}),
  };
}

/** Read all enabled rows for the configured warehouse work date. */
export async function getTodayEngineeringPlanContext(): Promise<EngineeringPlanContext> {
  const query = "today's enabled engineering plan";
  const sheet = await readEngineeringPlanRows();
  if (sheet.reason) {
    return {
      configured: sheet.configured,
      query,
      currentWorkDate: sheet.currentWorkDate,
      matchCount: 0,
      rows: [],
      reason: sheet.reason,
    };
  }
  const matches = findTodayEngineeringPlanRows(sheet.rows, sheet.currentWorkDate);
  return {
    configured: true,
    query,
    currentWorkDate: sheet.currentWorkDate,
    matchCount: matches.length,
    rows: matches,
    ...(matches.length === 0 ? { reason: "no_match" as const } : {}),
  };
}
