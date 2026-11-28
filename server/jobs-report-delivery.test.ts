import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { describe, expect, it } from "vitest";

import {
  deliverRunReport,
  reportDeliveryLine,
  REPORT_TEXT_MAX_CHARS,
  type ReportDeliveryOutcome,
} from "./jobs-report-delivery.ts";

const SECRET = "test-secret-value";

interface CapturedRequest {
  method?: string;
  secretHeader?: string | string[];
  body: string;
}

async function startServer(
  handler: (req: IncomingMessage, res: ServerResponse, captured: CapturedRequest) => void,
): Promise<{ url: string; captured: CapturedRequest; close: () => Promise<void> }> {
  const captured: CapturedRequest = { body: "" };
  const server: Server = createServer((req, res) => {
    captured.method = req.method;
    captured.secretHeader = req.headers["x-sanremes-notify-secret"];
    req.on("data", (chunk: Buffer) => {
      captured.body += chunk.toString("utf8");
    });
    req.on("end", () => handler(req, res, captured));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (typeof address !== "object" || !address) throw new Error("loopback server did not bind");
  return {
    url: `http://127.0.0.1:${address.port}/notify`,
    captured,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

function okHandler(_req: IncomingMessage, res: ServerResponse): void {
  res.writeHead(200, { "content-type": "application/json" });
  res.end("{}");
}

describe("deliverRunReport", () => {
  it("sends to each configured channel on 200", async () => {
    const whatsapp = await startServer(okHandler);
    const telegram = await startServer(okHandler);
    try {
      const outcomes = await deliverRunReport({
        runId: "run-1",
        text: "Applied to 2 jobs.",
        whatsapp: { url: whatsapp.url, secret: SECRET },
        telegram: { url: telegram.url, secret: SECRET },
      });
      expect(outcomes).toEqual([
        { channel: "whatsapp", status: "sent" },
        { channel: "telegram", status: "sent" },
      ]);
      for (const { captured } of [whatsapp, telegram]) {
        expect(captured.method).toBe("POST");
        expect(captured.secretHeader).toBe(SECRET);
        expect(JSON.parse(captured.body)).toEqual({
          source: "sanremes-job-bot",
          runId: "run-1",
          text: "Applied to 2 jobs.",
        });
      }
    } finally {
      await whatsapp.close();
      await telegram.close();
    }
  });

  it("reports failed on 4xx and 5xx", async () => {
    const badRequest = await startServer((_req, res) => {
      res.writeHead(400);
      res.end("secret-bearing error body must never surface");
    });
    const serverError = await startServer((_req, res) => {
      res.writeHead(500);
      res.end("boom");
    });
    try {
      const outcomes = await deliverRunReport({
        runId: "run-2",
        text: "Report.",
        whatsapp: { url: badRequest.url, secret: SECRET },
        telegram: { url: serverError.url, secret: SECRET },
      });
      expect(outcomes).toEqual([
        { channel: "whatsapp", status: "failed", note: "the bridge rejected the report" },
        { channel: "telegram", status: "failed", note: "the bridge rejected the report" },
      ]);
      for (const outcome of outcomes) expect(outcome.note).not.toContain(SECRET);
    } finally {
      await badRequest.close();
      await serverError.close();
    }
  });

  it("reports failed on an unreachable URL", async () => {
    const outcomes = await deliverRunReport({
      runId: "run-3",
      text: "Report.",
      whatsapp: { url: "http://127.0.0.1:1/notify", secret: SECRET },
    });
    expect(outcomes[0]).toEqual({
      channel: "whatsapp",
      status: "failed",
      note: "the bridge could not be reached",
    });
    expect(outcomes[1]).toEqual({ channel: "telegram", status: "not-configured" });
  });

  it("reports not-configured without calling fetch", async () => {
    let calls = 0;
    const fetchImpl = (async () => {
      calls += 1;
      return new Response("{}", { status: 200 });
    }) as typeof fetch;
    const outcomes = await deliverRunReport({ runId: "run-4", text: "Report.", fetchImpl });
    expect(outcomes).toEqual([
      { channel: "whatsapp", status: "not-configured" },
      { channel: "telegram", status: "not-configured" },
    ]);
    expect(calls).toBe(0);
  });

  it("aborts after the injected timeout", async () => {
    const hanging = await startServer(() => {
      // Never responds.
    });
    try {
      const started = Date.now();
      const outcomes = await deliverRunReport({
        runId: "run-5",
        text: "Report.",
        whatsapp: { url: hanging.url, secret: SECRET },
        timeoutMs: 50,
      });
      expect(Date.now() - started).toBeLessThan(5000);
      expect(outcomes[0]).toEqual({
        channel: "whatsapp",
        status: "failed",
        note: "the bridge did not answer in time",
      });
    } finally {
      await hanging.close();
    }
  });

  it("caps the text at 4000 chars with an ellipsis", async () => {
    const server = await startServer(okHandler);
    try {
      const longText = "x".repeat(5000);
      await deliverRunReport({
        runId: "run-6",
        text: longText,
        whatsapp: { url: server.url, secret: SECRET },
      });
      const sent = JSON.parse(server.captured.body).text as string;
      expect(sent.length).toBe(REPORT_TEXT_MAX_CHARS);
      expect(sent.endsWith("...")).toBe(true);
    } finally {
      await server.close();
    }
  });

  it("never puts the secret in a note or a thrown error", async () => {
    const throwingFetch = (async () => {
      throw new Error(`network down, secret was ${SECRET}`);
    }) as typeof fetch;
    const outcomes = await deliverRunReport({
      runId: "run-7",
      text: "Report.",
      whatsapp: { url: "http://127.0.0.1:1/notify", secret: SECRET },
      fetchImpl: throwingFetch,
    });
    expect(outcomes[0].status).toBe("failed");
    expect(outcomes[0].note).not.toContain(SECRET);
    expect(JSON.stringify(outcomes)).not.toContain(SECRET);
  });
});

describe("reportDeliveryLine", () => {
  const sent = (channel: ReportDeliveryOutcome["channel"]): ReportDeliveryOutcome => ({ channel, status: "sent" });
  const pending = (channel: ReportDeliveryOutcome["channel"]): ReportDeliveryOutcome => ({
    channel,
    status: "not-configured",
  });
  const failed = (channel: ReportDeliveryOutcome["channel"]): ReportDeliveryOutcome => ({
    channel,
    status: "failed",
    note: "the bridge did not answer",
  });

  it("covers sent, pending, and failed combinations", () => {
    expect(reportDeliveryLine([sent("whatsapp")])).toBe("Report sent to WhatsApp.");
    expect(reportDeliveryLine([sent("whatsapp"), sent("telegram")])).toBe(
      "Report sent to WhatsApp. Report sent to Telegram.",
    );
    expect(reportDeliveryLine([pending("whatsapp")])).toBe(
      "WhatsApp delivery is pending bridge setup — read the report here.",
    );
    expect(reportDeliveryLine([pending("whatsapp"), pending("telegram")])).toBe(
      "WhatsApp delivery is pending bridge setup — read the report here. Telegram delivery is pending bridge setup — read the report here.",
    );
    expect(reportDeliveryLine([failed("whatsapp")])).toBe(
      "WhatsApp delivery failed (the bridge did not answer) — read the report here.",
    );
    expect(reportDeliveryLine([sent("whatsapp"), failed("telegram")])).toBe(
      "Report sent to WhatsApp. Telegram delivery failed (the bridge did not answer) — read the report here.",
    );
    expect(reportDeliveryLine([sent("telegram"), pending("whatsapp")])).toBe(
      "Report sent to Telegram. WhatsApp delivery is pending bridge setup — read the report here.",
    );
    expect(reportDeliveryLine([])).toBe("Report delivery is pending bridge setup — read the report here.");
  });
});
