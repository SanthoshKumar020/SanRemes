// Cerebras and Mistral as decision providers, borrowing the engine key saved under Settings → API keys.
// No live calls: every fetch is a fake.
import { afterEach, describe, expect, it, vi } from "vitest";

import type { AppConfig } from "../config.ts";
import { CEREBRAS_DECIDER_MODEL, MISTRAL_DECIDER_MODEL } from "./chat.ts";
import { createDecider, deciderAccounts, deciderBorrowedKey, describeDecider } from "./index.ts";

const CB_KEY = "csk-unit-cerebras-key-0123456789abcdef";
const MI_KEY = "unit-mistral-key-0123456789abcdef";
const OPTIONS = { maya: "Maya, Product Designer bot.", theo: "Theo, Frontend Engineer bot." };
const QUESTION = { instructions: "Which bot should answer `new_message`?", options: OPTIONS };
const STATE = { new_message: { from: "Milind", text: "PRIVATE-MESSAGE-TEXT the navbar overlaps on Safari" } };

type FetchMock = ReturnType<typeof vi.fn<typeof fetch>>;

/** What both vendors return: the model's JSON is a string in choices[0].message.content. */
function completion(answers: unknown, model = "gpt-oss-120b"): Response {
  return new Response(JSON.stringify({
    model,
    choices: [{ message: { role: "assistant", content: typeof answers === "string" ? answers : JSON.stringify(answers) } }],
    usage: { prompt_tokens: 210, completion_tokens: 18 },
  }), { status: 200, headers: { "content-type": "application/json" } });
}
const choiceAnswers = (choice: string, probabilities: Record<string, number>) => ({ answers: { answer: { choice, probabilities } } });

function decider(config: AppConfig, fetchImpl: FetchMock) {
  return createDecider({ config: () => config, fetch: fetchImpl as unknown as typeof fetch });
}

afterEach(() => vi.restoreAllMocks());

describe("Cerebras as a decision provider", () => {
  const CB: AppConfig = { cerebras: { key: CB_KEY }, decider: { enabled: true, jobs: { roomRouting: true } } };

  it("POSTs strict JSON-schema chat completions with the engine key and gpt-oss-120b", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(completion(choiceAnswers("theo", { theo: 0.97, maya: 0.03 })));
    const result = await decider(CB, fetchImpl).choose("roomRouting", STATE, QUESTION);
    expect(result).toMatchObject({ ok: true, provider: "cerebras", inputTokens: 210, model: "gpt-oss-120b" });
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(String(url)).toBe("https://api.cerebras.ai/v1/chat/completions");
    expect(init?.method).toBe("POST");
    expect(init?.redirect).toBe("error");
    expect(init?.headers).toMatchObject({ authorization: `Bearer ${CB_KEY}`, "content-type": "application/json" });
    const body = JSON.parse(String(init?.body));
    expect(body).toMatchObject({
      model: CEREBRAS_DECIDER_MODEL,
      temperature: 0,
      response_format: { type: "json_schema", json_schema: { name: "decision", strict: true } },
    });
    expect(body).not.toHaveProperty("provider");
    expect(body).not.toHaveProperty("reasoning");
    expect(JSON.stringify(body)).not.toContain(CB_KEY);
  });

  it("a draft key is checked at Cerebras, and the saved key by default", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => completion({ answers: { answer: { noul: 0.97 } } }));
    const d = decider({ cerebras: { key: CB_KEY }, decider: { enabled: false } }, fetchImpl);
    await expect(d.testKey({ provider: "cerebras", key: "csk_draft" })).resolves.toMatchObject({ ok: true, provider: "cerebras", answers: { p: 0.97 } });
    expect((fetchImpl.mock.calls[0]![1]!.headers as Record<string, string>).authorization).toBe("Bearer csk_draft");
    await expect(d.testKey()).resolves.toMatchObject({ ok: true, provider: "cerebras" });
    expect((fetchImpl.mock.calls[1]![1]!.headers as Record<string, string>).authorization).toBe(`Bearer ${CB_KEY}`);
    expect(String(fetchImpl.mock.calls[1]![0])).toBe("https://api.cerebras.ai/v1/chat/completions");
  });

  it("a model override reaches the backend", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(completion({ answers: { answer: { noul: 0.9 } } }, "qwen-3.8-27b"));
    await decider(CB, fetchImpl).testKey({ provider: "cerebras", model: "qwen-3.8-27b" });
    expect(JSON.parse(String(fetchImpl.mock.calls[0]![1]?.body)).model).toBe("qwen-3.8-27b");
  });

  it("with only a Cerebras key the decider is configured, on once switched on, and named in Settings", () => {
    expect(deciderBorrowedKey(CB)).toBe(true);
    expect(deciderAccounts(CB)).toHaveLength(1);
    expect(deciderAccounts(CB)[0]).toMatchObject({ provider: "cerebras", api: "https://api.cerebras.ai/v1" });
    expect(describeDecider(CB)).toEqual({ provider: "cerebras", configured: true, enabled: true, jobs: { roomRouting: true } });
    expect(describeDecider({ cerebras: { key: CB_KEY }, decider: { enabled: true, provider: "jev" } }))
      .toMatchObject({ provider: "cerebras", chosen: "jev", configured: true });
  });
});

describe("Mistral as a decision provider", () => {
  const MI: AppConfig = { mistral: { key: MI_KEY }, decider: { enabled: true, jobs: { roomRouting: true } } };

  it("POSTs strict JSON-schema chat completions with the engine key and mistral-small-latest", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(completion(choiceAnswers("maya", { maya: 0.91, theo: 0.09 }), "mistral-small-latest"));
    const result = await decider(MI, fetchImpl).choose("roomRouting", STATE, QUESTION);
    expect(result).toMatchObject({ ok: true, provider: "mistral", inputTokens: 210, model: "mistral-small-latest" });
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(String(url)).toBe("https://api.mistral.ai/v1/chat/completions");
    expect(init?.headers).toMatchObject({ authorization: `Bearer ${MI_KEY}` });
    expect(JSON.parse(String(init?.body))).toMatchObject({
      model: MISTRAL_DECIDER_MODEL,
      temperature: 0,
      response_format: { type: "json_schema", json_schema: { name: "decision", strict: true } },
    });
  });

  it("a draft key is checked at Mistral, and the saved key by default", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => completion({ answers: { answer: { noul: 0.97 } } }));
    const d = decider({ mistral: { key: MI_KEY }, decider: { enabled: false } }, fetchImpl);
    await expect(d.testKey({ provider: "mistral", key: "draft" })).resolves.toMatchObject({ ok: true, provider: "mistral" });
    expect((fetchImpl.mock.calls[0]![1]!.headers as Record<string, string>).authorization).toBe("Bearer draft");
    await expect(d.testKey()).resolves.toMatchObject({ ok: true, provider: "mistral" });
    expect((fetchImpl.mock.calls[1]![1]!.headers as Record<string, string>).authorization).toBe(`Bearer ${MI_KEY}`);
  });

  it("with only a Mistral key the decider is configured and named in Settings", () => {
    expect(deciderBorrowedKey(MI)).toBe(true);
    expect(describeDecider(MI)).toEqual({ provider: "mistral", configured: true, enabled: true, jobs: { roomRouting: true } });
    expect(describeDecider({ mistral: { key: MI_KEY }, decider: { enabled: true, provider: "openrouter" } }))
      .toMatchObject({ provider: "mistral", chosen: "openrouter", configured: true });
  });
});

describe("the chat backends' failures", () => {
  it.each([
    [401, "rejected"],
    [429, "rate_limited"],
    [500, "http_error"],
    [503, "overloaded"],
  ])("Cerebras HTTP %i → %s, never the body", async (status, reason) => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response(`bad key ${CB_KEY}`, { status }));
    const result = await decider({ cerebras: { key: CB_KEY }, decider: { enabled: true } }, fetchImpl)
      .choose("roomRouting", STATE, QUESTION);
    expect(result).toMatchObject({ ok: false, provider: "cerebras", reason, status });
    expect(JSON.stringify(result)).not.toContain(CB_KEY);
  });

  it("questions outside the limits never call either vendor", async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    const many = Object.fromEntries(Array.from({ length: 256 }, (_, i) => [`o${i}`, `option ${i}`]));
    for (const config of [
      { cerebras: { key: CB_KEY }, decider: { enabled: true } },
      { mistral: { key: MI_KEY }, decider: { enabled: true } },
    ] as AppConfig[]) {
      await expect(decider(config, fetchImpl).choose("roomRouting", STATE, { instructions: "?", options: many }))
        .resolves.toMatchObject({ ok: false, reason: "misconfigured" });
    }
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("Cerebras comes before Mistral, and both after OpenRouter", () => {
    const config: AppConfig = {
      openrouter: { key: "sk-or-v1-unit-shared-0123456789" },
      cerebras: { key: CB_KEY },
      mistral: { key: MI_KEY },
      decider: { enabled: true, provider: "openrouter", openrouterModel: "openai/gpt-4o-mini" },
    };
    expect(deciderAccounts(config).map((account) => account.provider)).toEqual(["openrouter", "cerebras", "mistral"]);
  });
});
