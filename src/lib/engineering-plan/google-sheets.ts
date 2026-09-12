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

/** Convert the bounded Sheets values response into trusted field names. */
export function parseEngineeringPlanValues(values: unknown[][]): EngineeringPlanRow[] {
  const [rawHeaders, ...rawRows] = values;
  if (!rawHeaders) return [];
  const positions = new Map<string, number>();
  rawHeaders.forEach((header, index) => positions.set(text(header), index));
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

function sheetsConfig() {
  const spreadsheetId = process.env.ENGINEERING_PLAN_SPREADSHEET_ID?.trim();
  const range = process.env.ENGINEERING_PLAN_SHEET_RANGE?.trim() || "'Daily Plan'!A1:N250";
  return spreadsheetId ? { spreadsheetId, range } : null;
}

function currentWorkDate(): string {
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

/** Read-only, bounded Google Sheets lookup used by the Materials Planner. */
export async function getEngineeringPlanContext(query: string): Promise<EngineeringPlanContext> {
  const config = sheetsConfig();
  const workDate = currentWorkDate();
  if (!config) return { configured: false, query, currentWorkDate: workDate, matchCount: 0, rows: [], reason: "not_configured" };

  try {
    const authorization = await authorizationHeader();
    const apiKey = process.env.GOOGLE_SHEETS_API_KEY?.trim();
    if (!authorization && !apiKey) {
      return { configured: false, query, currentWorkDate: workDate, matchCount: 0, rows: [], reason: "not_configured" };
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
    const matches = findEngineeringPlanRows(parseEngineeringPlanValues(payload.values ?? []), query);
    return {
      configured: true,
      query,
      currentWorkDate: workDate,
      matchCount: matches.length,
      rows: matches,
      ...(matches.length === 0 ? { reason: "no_match" as const } : {}),
    };
  } catch (error) {
    console.error("[engineering-plan] Google Sheets read failed:", error);
    return { configured: true, query, currentWorkDate: workDate, matchCount: 0, rows: [], reason: "unavailable" };
  }
}
