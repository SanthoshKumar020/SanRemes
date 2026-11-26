// The person's own Cerebras or Mistral key, asked over OpenAI-compatible chat with the same strict-JSON body
// OpenRouter's chat path sends. Both vendors enforce that shape: Cerebras documents `json_schema` with
// `strict: true` for gpt-oss-120b, Mistral for every current model except codestral-mamba.
import { keySafeUrl } from "../provider-key-check.ts";
import { chatRequestBody, parseChatResponse } from "./openrouter.ts";
import { questionsFit, refusal } from "./jev.ts";
import type { BackendRequest, BackendResult, DeciderBackend, DeciderProvider } from "./types.ts";

export const CEREBRAS_DECIDER_URL = "https://api.cerebras.ai/v1";
export const CEREBRAS_DECIDER_MODEL = "gpt-oss-120b";
export const MISTRAL_DECIDER_URL = "https://api.mistral.ai/v1";
export const MISTRAL_DECIDER_MODEL = "mistral-small-latest";

function chatBackend(id: DeciderProvider, baseUrl: string, defaultModel: string): DeciderBackend {
  async function decide(request: BackendRequest): Promise<BackendResult> {
    const endpoint = keySafeUrl(request.baseUrl?.trim() || baseUrl, "chat/completions");
    if (!endpoint || !questionsFit(request.questions)) return { ok: false, reason: "misconfigured" };
    const model = request.model?.trim() || defaultModel;
    let response: Response;
    try {
      response = await request.fetch(endpoint, {
        method: "POST",
        headers: { authorization: `Bearer ${request.key}`, "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify(chatRequestBody(request.state, request.questions, model)),
        signal: request.signal,
        // Never replay the key to wherever a redirect points.
        redirect: "error",
      });
    } catch {
      return { ok: false, reason: "unreachable" };
    }
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      return refusal(response.status);
    }
    let body: unknown;
    try {
      body = await response.json();
    } catch {
      return { ok: false, reason: "malformed" };
    }
    return parseChatResponse(body, request.questions);
  }
  return { id, decide };
}

export const cerebrasBackend: DeciderBackend = chatBackend("cerebras", CEREBRAS_DECIDER_URL, CEREBRAS_DECIDER_MODEL);
export const mistralBackend: DeciderBackend = chatBackend("mistral", MISTRAL_DECIDER_URL, MISTRAL_DECIDER_MODEL);
