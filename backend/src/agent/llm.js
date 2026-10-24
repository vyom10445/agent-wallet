// Pluggable LLM client over plain fetch (no SDK dependency). Chosen by backend/.env:
//   LLM_PROVIDER = none | anthropic | openai-compatible   (default: none -> deterministic fallback planner)
//   LLM_API_KEY, LLM_MODEL, LLM_BASE_URL, LLM_TIMEOUT_MS
// "openai-compatible" covers OpenAI, Google Gemini's OpenAI endpoint and Ollama (see README).
//
// Every provider gets the same neutral transcript and returns the same shape:
//   transcript: [{ role: "user", text } | { role: "assistant", text, toolCalls, raw } | { role: "tool", results: [{ id, name, content }] }]
//   result:     { text, toolCalls: [{ id, name, input }], raw }
// The API key is only put in a request header. It is never logged or returned, and errors never include it.

export class LlmError extends Error {
  name = "LlmError";
}

const DEFAULTS = {
  anthropic: { baseUrl: "https://api.anthropic.com", model: "claude-opus-5-5" },
  "openai-compatible": { baseUrl: "https://api.openai.com/v1", model: "gpt-4o-mini" },
};
// Anthropic models that support server-side refusal fallbacks with `fallbacks: "default"`.
const FALLBACK_MODELS = new Set(["claude-fable-5-1", "claude-opus-5-5", "claude-opus-5", "claude-sonnet-5-5"]);

async function postJson(fetchImpl, url, headers, body, timeoutMs, apiKey) {
  let res;
  try {
    res = await fetchImpl(url, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs) });
  } catch (e) {
    throw new LlmError(`LLM request failed: ${e.name === "TimeoutError" ? `timed out after ${timeoutMs} ms` : e.message}`);
  }
  const text = await res.text();
  if (!res.ok) {
    const safe = apiKey ? text.split(apiKey).join("[redacted]") : text;
    throw new LlmError(`LLM HTTP ${res.status}: ${safe.slice(0, 300)}`);
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new LlmError("LLM returned invalid JSON");
  }
}

function anthropicClient({ apiKey, model, baseUrl, timeoutMs, fetchImpl }) {
  const useFallbacks = FALLBACK_MODELS.has(model);
  const toMessages = (transcript) =>
    transcript.map((t) => {
      if (t.role === "user") return { role: "user", content: t.text };
      if (t.role === "assistant") {
        if (t.raw) return { role: "assistant", content: t.raw }; // replay content blocks unchanged (thinking included)
        return { role: "assistant", content: t.text || "(no text)" };
      }
      return { role: "user", content: t.results.map((r) => ({ type: "tool_result", tool_use_id: r.id, content: r.content, ...(r.isError ? { is_error: true } : {}) })) };
    });

  return {
    provider: "anthropic",
    model,
    async chat({ system, transcript, tools }) {
      const headers = { "x-api-key": apiKey, "anthropic-version": "2026-10-21" };
      const body = {
        model,
        max_tokens: 16000,
        system,
        messages: toMessages(transcript),
        tools: tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.input_schema })),
        tool_choice: { type: "auto" },
        output_config: { effort: "low" }, // short chat turns with tool calls; raise to "medium" if replies get sloppy
      };
      if (useFallbacks) {
        headers["anthropic-beta"] = "server-side-fallback-2026-07-01";
        body.fallbacks = "default";
      }
      const res = await postJson(fetchImpl, `${baseUrl.replace(/\/$/, "")}/v1/messages`, headers, body, timeoutMs, apiKey);
      if (res.stop_reason === "refusal") throw new LlmError(`LLM refused (${res.stop_details?.category ?? "no category"})`);
      if (res.stop_reason === "max_tokens") throw new LlmError("LLM hit max_tokens");
      const content = Array.isArray(res.content) ? res.content : [];
      return {
        text: content.filter((b) => b.type === "text").map((b) => b.text).join("\n").trim(),
        toolCalls: content.filter((b) => b.type === "tool_use").map((b) => ({ id: b.id, name: b.name, input: b.input })),
        raw: content,
      };
    },
  };
}

function openAiCompatibleClient({ apiKey, model, baseUrl, timeoutMs, fetchImpl }) {
  const toMessages = (system, transcript) => [
    { role: "system", content: system },
    ...transcript.flatMap((t) => {
      if (t.role === "user") return [{ role: "user", content: t.text }];
      if (t.role === "assistant") {
        if (t.raw) return [t.raw];
        return [{ role: "assistant", content: t.text || "" }];
      }
      return t.results.map((r) => ({ role: "tool", tool_call_id: r.id, content: r.content }));
    }),
  ];

  return {
    provider: "openai-compatible",
    model,
    async chat({ system, transcript, tools }) {
      const headers = apiKey ? { authorization: `Bearer ${apiKey}` } : {}; // Ollama needs no key
      const body = {
        model,
        messages: toMessages(system, transcript),
        tools: tools.map((t) => ({ type: "function", function: { name: t.name, description: t.description, parameters: t.input_schema } })),
        tool_choice: "auto",
      };
      const res = await postJson(fetchImpl, `${baseUrl.replace(/\/$/, "")}/chat/completions`, headers, body, timeoutMs, apiKey);
      const msg = res.choices?.[0]?.message;
      if (!msg) throw new LlmError("LLM returned no message");
      const toolCalls = (msg.tool_calls ?? []).map((c, i) => {
        let input;
        try {
          input = typeof c.function?.arguments === "string" ? JSON.parse(c.function.arguments || "{}") : c.function?.arguments ?? {};
        } catch {
          input = { __invalid_json__: true }; // fails validation, nothing runs
        }
        return { id: c.id ?? `call_${i}`, name: c.function?.name, input };
      });
      const raw = { role: "assistant", content: msg.content ?? "", ...(msg.tool_calls?.length ? { tool_calls: msg.tool_calls } : {}) };
      return { text: (msg.content ?? "").trim(), toolCalls, raw };
    },
  };
}

/** Returns null for provider "none" (use the fallback planner). Throws on a bad configuration. */
export function createLlmFromEnv(env = process.env, { fetchImpl = globalThis.fetch } = {}) {
  const provider = (env.LLM_PROVIDER?.trim() || "none").toLowerCase();
  if (provider === "none") return null;
  if (!DEFAULTS[provider]) throw new LlmError(`LLM_PROVIDER must be none, anthropic or openai-compatible, got "${provider}".`);
  const apiKey = env.LLM_API_KEY?.trim() || "";
  const baseUrl = env.LLM_BASE_URL?.trim() || DEFAULTS[provider].baseUrl;
  const isLocal = /^https?:\/\/(localhost|127\.0\.0\.1)/.test(baseUrl);
  if (!apiKey && !isLocal) throw new LlmError(`LLM_API_KEY is missing for LLM_PROVIDER=${provider}. Set it in backend/.env, or use LLM_PROVIDER=none.`);
  const opts = { apiKey, model: env.LLM_MODEL?.trim() || DEFAULTS[provider].model, baseUrl, timeoutMs: Number(env.LLM_TIMEOUT_MS || 30_000), fetchImpl };
  return provider === "anthropic" ? anthropicClient(opts) : openAiCompatibleClient(opts);
}
