/** The model the optional Ollama install downloads. */
export const LOCAL_QWEN_MODEL = "qwen3:4b";
export const LOCAL_QWEN_URL = "http://127.0.0.1:11434";

/** Pull a model through Ollama's API, reporting overall download progress; throws when the pull fails. */
export async function pullOllamaModel(
  url: string,
  model: string,
  fetchImpl: typeof fetch,
  onProgress?: (percent: number) => void,
): Promise<void> {
  const response = await fetchImpl(`${url}/api/pull`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: model, stream: true }),
  });
  if (!response.ok || !response.body) throw new Error(`Ollama refused the ${model} download (HTTP ${response.status})`);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const layers = new Map<string, { completed: number; total: number }>();
  let buffer = "";
  let lastError: string | undefined;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.trim()) continue;
      let event: { status?: unknown; digest?: unknown; completed?: unknown; total?: unknown; error?: unknown };
      try {
        event = JSON.parse(line) as typeof event;
      } catch {
        continue;
      }
      if (typeof event.error === "string" && event.error) lastError = event.error;
      if (typeof event.digest === "string" && typeof event.completed === "number" && typeof event.total === "number" && event.total > 0) {
        layers.set(event.digest, { completed: event.completed, total: event.total });
        const doneBytes = [...layers.values()].reduce((sum, layer) => sum + layer.completed, 0);
        const allBytes = [...layers.values()].reduce((sum, layer) => sum + layer.total, 0);
        onProgress?.(Math.min(100, Math.round((doneBytes / allBytes) * 100)));
      }
    }
  }
  if (lastError) throw new Error(lastError);
}
