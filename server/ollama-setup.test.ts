import { describe, expect, it } from "vitest";

import { LOCAL_QWEN_MODEL, LOCAL_QWEN_URL, pullOllamaModel } from "./ollama-setup.ts";

describe("pullOllamaModel", () => {
  it("throws on a pull error event", async () => {
    const fetchImpl = (async () => {
      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(`{"error":"no space left"}\n`));
          controller.close();
        },
      });
      return new Response(stream, { status: 200 });
    }) as unknown as typeof fetch;
    await expect(pullOllamaModel(LOCAL_QWEN_URL, LOCAL_QWEN_MODEL, fetchImpl)).rejects.toThrow("no space left");
  });

  it("reports overall progress across layers", async () => {
    const percents: number[] = [];
    const lines = [
      `{"status":"pulling a","digest":"sha256:a","total":100,"completed":50}`,
      `{"status":"pulling a","digest":"sha256:a","total":100,"completed":100}`,
      `{"status":"pulling b","digest":"sha256:b","total":100,"completed":50}`,
      `{"status":"success"}`,
    ];
    const fetchImpl = (async () => {
      const stream = new ReadableStream({
        start(controller) {
          for (const line of lines) controller.enqueue(new TextEncoder().encode(`${line}\n`));
          controller.close();
        },
      });
      return new Response(stream, { status: 200 });
    }) as unknown as typeof fetch;
    await pullOllamaModel(LOCAL_QWEN_URL, LOCAL_QWEN_MODEL, fetchImpl, (percent) => percents.push(percent));
    expect(percents).toEqual([50, 100, 75]);
  });
});
