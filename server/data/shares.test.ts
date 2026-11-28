import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { DataShareStore, sourcesFor, validateShareSql } from "./shares.ts";

describe("sourcesFor", () => {
  it("finds tables after FROM and JOIN, schema prefix stripped", () => {
    expect(sourcesFor('SELECT a.x FROM "sales".orders o JOIN customers c ON c.id = o.cid WHERE o.total > 10')).toEqual(["orders", "customers"]);
  });

  it("dedupes and caps at twenty", () => {
    const sql = Array.from({ length: 25 }, (_, i) => `t${i}`).map((t, i) => (i === 0 ? `FROM ${t}` : `JOIN ${t} ON 1=1`)).join(" ");
    expect(sourcesFor(sql)).toHaveLength(20);
  });

  it("finds nothing in a query with no tables", () => {
    expect(sourcesFor("SELECT 1")).toEqual([]);
  });
});

describe("validateShareSql", () => {
  it("accepts SELECT and WITH", () => {
    expect(validateShareSql("SELECT * FROM orders")).toBeNull();
    expect(validateShareSql("WITH recent AS (SELECT * FROM orders) SELECT * FROM recent")).toBeNull();
  });

  it("rejects writes, multi-statement SQL and empty SQL", () => {
    expect(validateShareSql("DELETE FROM orders")).not.toBeNull();
    expect(validateShareSql("SELECT * FROM orders; DROP TABLE orders")).not.toBeNull();
    expect(validateShareSql("   ")).not.toBeNull();
    expect(validateShareSql("ATTACH 'x.db' AS x")).not.toBeNull();
  });
});

describe("DataShareStore", () => {
  const dir = () => mkdtempSync(join(tmpdir(), "sanremes-data-shares-"));

  it("creates, lists, certifies and revokes shares", () => {
    const dataDir = dir();
    try {
      const store = new DataShareStore({ dataDir, now: () => 1000 });
      const share = store.create({ botId: "bot-1", title: "Weekly orders", sql: "SELECT * FROM orders" });
      expect(share.id.startsWith("ds_")).toBe(true);
      expect(share.sources).toEqual(["orders"]);
      expect(share.certified).toBeNull();
      expect(store.list("bot-1")).toHaveLength(1);
      expect(store.list("bot-2")).toHaveLength(0);

      const certified = store.certify(share.id, "owner", "Checked against the source sheet.");
      expect(certified?.certified).toEqual({ by: "owner", at: 1000, note: "Checked against the source sheet." });
      expect(store.certify("ds_missing", "owner")).toBeUndefined();

      const revoked = store.revoke(share.id);
      expect(revoked?.revokedAt).toBe(1000);
      expect(store.list("bot-1")).toHaveLength(0);
      expect(store.revoke(share.id)).toBeUndefined();
      expect(store.certify(share.id, "owner")).toBeUndefined();
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it("reloads shares from disk", () => {
    const dataDir = dir();
    try {
      const first = new DataShareStore({ dataDir, now: () => 1000 });
      const share = first.create({ botId: "bot-1", title: "Weekly orders", sql: "SELECT * FROM orders" });
      const second = new DataShareStore({ dataDir });
      expect(second.get(share.id)?.title).toBe("Weekly orders");
      expect(second.get(share.id)?.sources).toEqual(["orders"]);
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });
});
