// Scripted LLM for tests: each step is a response object or a function (transcript) => response.
// Records every transcript the "model" was shown.
export function mockLlm(steps) {
  const seen = [];
  return {
    provider: "mock",
    model: "mock",
    seen,
    async chat({ system, transcript, tools }) {
      seen.push(JSON.stringify({ system, transcript, tools }));
      const step = steps.shift();
      if (!step) return { text: "", toolCalls: [], raw: null };
      if (step instanceof Error) throw step;
      const r = typeof step === "function" ? step(transcript) : step;
      return { text: r.text ?? "", toolCalls: r.toolCalls ?? [], raw: null };
    },
  };
}
export const call = (name, input, id = `call_${name}`) => ({ id, name, input });
