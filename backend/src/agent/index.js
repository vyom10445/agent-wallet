// Wires the agent from config, reads, store and backend/.env (LLM_PROVIDER, LLM_API_KEY, LLM_MODEL, LLM_BASE_URL).
import { createPurchaser } from "../chain/userop.js";
import { createTools } from "./tools.js";
import { createAgent } from "./agent.js";
import { createLlmFromEnv } from "./llm.js";

export { createAgent, BusyError, InputError, SYSTEM_PROMPT, describeBuy } from "./agent.js";
export { createTools, TOOL_DEFS, TOOL_NAMES, validateToolInput } from "./tools.js";
export { createLlmFromEnv, LlmError } from "./llm.js";
export { planFallback } from "./fallback.js";

export function buildAgent({ config, reads, store, env = process.env, purchaser, llm, log = console.warn }) {
  const tools = createTools({
    config, reads, store,
    purchaser: purchaser ?? createPurchaser(config, reads),
    approvalTtlSeconds: Number(env.APPROVAL_TTL_SECONDS || 86_400),
  });
  return createAgent({ llm: llm === undefined ? createLlmFromEnv(env) : llm, tools, store, log });
}
