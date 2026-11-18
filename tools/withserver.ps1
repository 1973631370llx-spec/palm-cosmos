# withserver.ps1 - start a local static server, run a command, then stop the server.
# Usage: powershell -ExecutionPolicy Bypass -File tools\withserver.ps1 -Run "node tools\smoke.mjs"
# ASCII only on purpose: PowerShell 5.1 parses .ps1 as ANSI when there is no BOM.
param(
  [Parameter(Mandatory = $true)][string]$Run,
  [int]$Port = 4173
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$node = 'C:\Users\II\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe'

$srv = Start-Process -FilePath $node -ArgumentList @('server.mjs', '--port', $Port) -WorkingDirectory $root -PassThru -WindowStyle Hidden
try {
  for ($i = 0; $i -lt 40; $i++) {
    try {
      $r = Invoke-WebRequest -Uri "http://127.0.0.1:$Port/" -UseBasicParsing -TimeoutSec 2
      if ($r.StatusCode -eq 200) { break }
    } catch { Start-Sleep -Milliseconds 250 }
  }
  Push-Location $root
  try { Invoke-Expression $Run } finally { Pop-Location }
}
finally {
  if ($srv -and -not $srv.HasExited) { Stop-Process -Id $srv.Id -Force -ErrorAction SilentlyContinue }
}