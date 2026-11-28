import { mkdirSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { DATA_DIR } from "../config.ts";
import { json, readBody } from "../harness/http.ts";
import { createStatusRoutes, type StatusRouteDeps } from "./status.ts";
import { dispatchRoutes } from "./table.ts";

const row = (at: string, tool: string) => JSON.stringify({
  at, threadId: "thread-1", decision: "auto-approved", source: "level", tool,
}) + "\n";

async function decisions(path: string) {
  const routes = [createStatusRoutes({ staticDir: null, sharedWorkspaceFullAccessEnabled: () => false } as unknown as StatusRouteDeps)];
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    await dispatchRoutes(routes, { req, res, url, path: url.pathname, method: req.method ?? "GET", auth: { kind: "loopback", scopes: ["admin", "client"] }, json, readBody });
  });
  await new Promise<void>((ready) => server.listen(0, "127.0.0.1", ready));
  try {
    const response = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}${path}`);
    return { status: response.status, body: await response.json() as Record<string, unknown> };
  } finally {
    server.close();
  }
}

describe("GET /api/decisions with a date range", () => {
  it("exports the range as JSON, caps the rows, and refuses a bad range", async () => {
    const dir = join(DATA_DIR, "decisions");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "2026-01.ndjson"), row("2026-01-05T10:00:00.000Z", "old-tool") + row("2026-01-20T10:00:00.000Z", "old-tool-2"));
    writeFileSync(join(dir, "2026-02.ndjson"), row("2026-02-03T10:00:00.000Z", "new-tool"));

    const jan = await decisions("/api/decisions?from=2026-01-01&to=2026-01-31");
    expect(jan.status).toBe(200);
    expect(jan.body.total).toBe(2);
    expect((jan.body.decisions as Array<{ tool: string }>).map((d) => d.tool)).toEqual(["old-tool", "old-tool-2"]);

    const capped = await decisions("/api/decisions?from=2026-01-01&to=2026-02-28&limit=2");
    expect(capped.status).toBe(200);
    expect((capped.body.decisions as unknown[])).toHaveLength(2);
    expect(capped.body.total).toBe(3);

    const bad = await decisions("/api/decisions?from=2026-02-01&to=2026-01-01");
    expect(bad.status).toBe(400);

    const plain = await decisions("/api/decisions?limit=1");
    expect(plain.status).toBe(200);
    expect((plain.body.decisions as unknown[])).toHaveLength(1);
    expect(plain.body).not.toHaveProperty("total");
  });
});
