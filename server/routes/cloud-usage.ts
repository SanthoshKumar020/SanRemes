// The usage report the Cloud site bills from: JSON for its billing read, CSV for a
// person to open. Amounts and counts only; no prices live here and no payment is taken.
import { buildCloudUsageReport, cloudUsageCsv } from "../cloud-usage-report.ts";
import { parseUsageRange, readUsage } from "../usage-ledger.ts";
import type { ManagedAgentRun } from "../../shared/managed-agents.ts";
import { PASS, type RouteHandler } from "./table.ts";

export interface CloudUsageRouteDeps {
  dataDir: string;
  agentRuns(from: Date, to: Date): ManagedAgentRun[];
  agentNames(): Map<string, string>;
}

export function createCloudUsageRoutes(deps: CloudUsageRouteDeps): RouteHandler {
  return async ({ res, path, method, json, url }) => {
    if (path !== "/api/cloud-usage/report" || method !== "GET") return PASS;
    const range = parseUsageRange(url.searchParams.get("from"), url.searchParams.get("to"));
    if (!range) return json(res, 400, { error: "Send a valid date range, at most a year." });
    const report = buildCloudUsageReport({
      from: range.from,
      to: range.to,
      rows: readUsage(deps.dataDir, range),
      agentRuns: deps.agentRuns(range.from, range.to),
      agentNames: deps.agentNames(),
    });
    if (url.searchParams.get("format") === "csv") {
      res.setHeader("content-type", "text/csv; charset=utf-8");
      res.setHeader("content-disposition", `attachment; filename="sanremes-cloud-usage-${range.from.toISOString().slice(0, 10)}-${range.to.toISOString().slice(0, 10)}.csv"`);
      res.end(cloudUsageCsv(report));
      return;
    }
    return json(res, 200, { report });
  };
}
