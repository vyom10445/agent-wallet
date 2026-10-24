#!/usr/bin/env bash
# Regenerates ../abi/*.json and ../abi/selectors.json from the compiled contracts (macOS/Linux/Git Bash).
# Run from agent-wallet/contracts:   ./export-abi.sh   (extra args are passed to forge, e.g. --offline)
set -euo pipefail
cd "$(dirname "$0")"
forge build "$@" >/dev/null 2>&1
declare -a pairs=("AgentWallet:AgentWallet" "IAgentWallet:IAgentWallet" "AgentWalletFactory:AgentWalletFactory"
  "MockUSDC:MockUSDC" "MockMerchant:MockMerchant" "EntryPoint:EntryPoint.v0.7.0")
sel="{"
for p in "${pairs[@]}"; do
  c="${p%%:*}"; f="${p##*:}"
  forge inspect "$c" abi --json "$@" > "../abi/$f.json"
  sel+="\"$c\":{\"functions\":$(forge inspect "$c" methodIdentifiers --json "$@"),\"events\":$(forge inspect "$c" events --json "$@"),\"errors\":$(forge inspect "$c" errors --json "$@")},"
  echo "abi/$f.json"
done
echo "${sel%,}}" | python3 -m json.tool --indent 2 > ../abi/selectors.json
echo "abi/selectors.json"
