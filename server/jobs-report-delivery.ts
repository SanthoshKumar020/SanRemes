// Desktop-side sender for Job Bot run reports.
//
// Security invariants: the notify secret is passed in by the caller, resolved
// from the Vault at send time. It is never stored in jobs.json, never logged,
// and never appears in a report, a chat message, or a returned note. This
// module logs nothing: no request headers, no request bodies, no responses.
export const REPORT_NOTIFY_CONTRACT =
  "POST the configured notify URL (one per channel, e.g. /api/whatsapp/notify " +
  "and /api/telegram/notify) with header x-sanremes-notify-secret: <secret> " +
  "and JSON body { source: \"sanremes-job-bot\", runId, text }. " +
  "HTTP 2xx means the bridge accepted the report for delivery; any other " +
  "status, network error, or timeout means delivery failed. " +
  "The bridge must never log the secret header or the request body.";

export const REPORT_TEXT_MAX_CHARS = 4000;
export const REPORT_NOTIFY_TIMEOUT_MS = 15_000;

export interface ReportChannelConfig {
  url: string;
  secret: string;
}

export interface ReportDeliveryInput {
  runId: string;
  text: string;
  whatsapp?: ReportChannelConfig;
  telegram?: ReportChannelConfig;
  fetchImpl?: typeof fetch;
  /** Defaults to REPORT_NOTIFY_TIMEOUT_MS. Tests pass a short value. */
  timeoutMs?: number;
}

export type ReportDeliveryChannel = "whatsapp" | "telegram";

export interface ReportDeliveryOutcome {
  channel: ReportDeliveryChannel;
  status: "sent" | "not-configured" | "failed";
  /** Plain-words reason for a failed delivery; never contains the secret. */
  note?: string;
}

const CHANNEL_LABEL: Record<ReportDeliveryChannel, string> = {
  whatsapp: "WhatsApp",
  telegram: "Telegram",
};

function truncateText(text: string): string {
  return text.length > REPORT_TEXT_MAX_CHARS
    ? `${text.slice(0, REPORT_TEXT_MAX_CHARS - 3)}...`
    : text;
}

async function deliverToChannel(
  channel: ReportDeliveryChannel,
  config: ReportChannelConfig | undefined,
  runId: string,
  text: string,
  fetchImpl: typeof fetch,
  timeoutMs: number,
): Promise<ReportDeliveryOutcome> {
  if (!config?.url) return { channel, status: "not-configured" };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(config.url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-sanremes-notify-secret": config.secret,
      },
      body: JSON.stringify({ source: "sanremes-job-bot", runId, text: truncateText(text) }),
      signal: controller.signal,
    });
    if (response.ok) return { channel, status: "sent" };
    return { channel, status: "failed", note: "the bridge rejected the report" };
  } catch (error) {
    const timedOut = error instanceof Error && error.name === "AbortError";
    return {
      channel,
      status: "failed",
      note: timedOut ? "the bridge did not answer in time" : "the bridge could not be reached",
    };
  } finally {
    clearTimeout(timer);
  }
}

/** Sends the run report to each configured channel, one outcome per channel. */
export async function deliverRunReport(input: ReportDeliveryInput): Promise<ReportDeliveryOutcome[]> {
  const fetchImpl = input.fetchImpl ?? fetch;
  const timeoutMs = input.timeoutMs ?? REPORT_NOTIFY_TIMEOUT_MS;
  return Promise.all([
    deliverToChannel("whatsapp", input.whatsapp, input.runId, input.text, fetchImpl, timeoutMs),
    deliverToChannel("telegram", input.telegram, input.runId, input.text, fetchImpl, timeoutMs),
  ]);
}

/** Plain-words line for the end of the run report, covering every outcome. */
export function reportDeliveryLine(outcomes: ReportDeliveryOutcome[]): string {
  if (outcomes.length === 0) return "Report delivery is pending bridge setup — read the report here.";
  return outcomes
    .map((outcome) => {
      const label = CHANNEL_LABEL[outcome.channel];
      if (outcome.status === "sent") return `Report sent to ${label}.`;
      if (outcome.status === "not-configured") return `${label} delivery is pending bridge setup — read the report here.`;
      return `${label} delivery failed (${outcome.note ?? "the bridge did not answer"}) — read the report here.`;
    })
    .join(" ");
}
