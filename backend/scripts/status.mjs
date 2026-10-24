// Prints the live state with the same labels and values as contracts/script/Status.s.sol, so the two can be compared.
// Read-only. Uses backend/.env (CHAIN_ID, RPC_URL, AGENT_PRIVATE_KEY, SUBMITTER_PRIVATE_KEY). Never prints a key.
import { loadConfig, ConfigError } from "../src/config.js";
import { createReads, assertStartup, StartupError, formatUsdc } from "../src/chain/reads.js";

try {
  const config = loadConfig();
  const reads = createReads(config);
  await assertStartup(config, reads);
  const s = await reads.snapshot();
  const usdc = (v) => `${v} (${formatUsdc(v)} mUSDC)`;
  const iso = (t) => new Date(Number(t) * 1000).toISOString();
  const rows = [
    ["chain id", s.chainId],
    ["EntryPoint", s.addresses.entryPoint],
    ["EntryPoint is v0.7", s.checks.entryPointIsV07],
    ["wallet.entryPoint ok", s.checks.walletEntryPointOk],
    ["factory -> wallet ok", s.checks.factoryWalletOk],
    ["wallet owner ok", s.checks.walletOwnerOk],
    ["merchant token ok", s.checks.merchantTokenOk],
    ["wallet mUSDC", usdc(s.wallet.balance)],
    ["merchant allowance", usdc(s.wallet.merchantAllowance)],
    ["EntryPoint deposit wei", s.wallet.entryPointDeposit],
    ["credits purchased", s.wallet.credits],
    ["merchant purchaseCount", s.merchant.purchaseCount],
    ["agent", s.addresses.agent],
    ["agent valid now", s.agent.validNow],
    ["maxPerTx", usdc(s.agent.maxPerTx)],
    ["dailyLimit", usdc(s.agent.dailyLimit)],
    ["spentToday", usdc(s.agent.spentToday)],
    ["remaining today", usdc(s.agent.remainingDailyAllowance)],
    // Extra lines (not in Status.s.sol):
    ["-- extra --", ""],
    ["block", s.blockNumber],
    ["agent active", s.agent.active],
    ["valid from / until", `${iso(s.agent.validAfter)} / ${iso(s.agent.validUntil)}`],
    ["can call purchase", s.agent.canPurchase],
    ["merchant allowed", s.agent.merchantAllowed],
    ["price per credit", usdc(s.merchant.pricePerCredit)],
    ["agent next nonce", `0x${s.agent.nextNonce.toString(16)}`],
  ];
  for (const [k, v] of rows) console.log(`  ${k.padEnd(23)} ${v}`);
} catch (e) {
  if (e instanceof ConfigError || e instanceof StartupError) {
    console.error(`${e.name}: ${e.message}`);
    process.exitCode = 1;
  } else {
    throw e;
  }
}
