// Talk to the agent from PowerShell without the HTTP server:  npm run chat -- "buy 50 credits"
// Uses backend/.env. Never prints a key.
import { loadConfig, ConfigError } from "../src/config.js";
import { createReads, assertStartup, StartupError } from "../src/chain/reads.js";
import { startStore } from "../src/db/index.js";
import { buildAgent, LlmError } from "../src/agent/index.js";

const message = process.argv.slice(2).join(" ").trim();
if (!message) {
  console.error('Usage: npm run chat -- "buy 50 credits"');
  process.exit(1);
}
try {
  const config = loadConfig();
  const reads = createReads(config);
  await assertStartup(config, reads);
  const { store } = await startStore(config, reads);
  const agent = buildAgent({ config, reads, store });
  const r = await agent.chat({ message });
  console.log(`[${r.planner}] ${r.reply}`);
  if (r.requestIds.length) console.log("requests:", r.requestIds.join(", "));
  store.close();
} catch (e) {
  if (e instanceof ConfigError || e instanceof StartupError || e instanceof LlmError) {
    console.error(`${e.name}: ${e.message}`);
    process.exitCode = 1;
  } else throw e;
}
