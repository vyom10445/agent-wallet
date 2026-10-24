# Regenerates ..\abi\*.json and ..\abi\selectors.json from the compiled contracts.
# Run from agent-wallet\contracts:   powershell -ExecutionPolicy Bypass -File .\export-abi.ps1
$ErrorActionPreference = "Stop"
forge build | Out-Null
$abiDir = Join-Path $PSScriptRoot "..\abi"
$contracts = [ordered]@{
    "AgentWallet"        = "AgentWallet"
    "IAgentWallet"       = "IAgentWallet"
    "AgentWalletFactory" = "AgentWalletFactory"
    "MockUSDC"           = "MockUSDC"
    "MockMerchant"       = "MockMerchant"
    "EntryPoint"         = "EntryPoint.v0.7.0"
}
$utf8 = New-Object System.Text.UTF8Encoding($false) # no BOM, so JSON.parse works
$selectors = [ordered]@{}
foreach ($c in $contracts.Keys) {
    $abi = (forge inspect $c abi --json | Out-String)
    [System.IO.File]::WriteAllText((Join-Path $abiDir "$($contracts[$c]).json"), $abi, $utf8)
    $selectors[$c] = [ordered]@{
        functions = (forge inspect $c methodIdentifiers --json | Out-String | ConvertFrom-Json)
        events    = (forge inspect $c events --json | Out-String | ConvertFrom-Json)
        errors    = (forge inspect $c errors --json | Out-String | ConvertFrom-Json)
    }
    Write-Host "abi\$($contracts[$c]).json"
}
[System.IO.File]::WriteAllText((Join-Path $abiDir "selectors.json"), ($selectors | ConvertTo-Json -Depth 5), $utf8)
Write-Host "abi\selectors.json"
