# share.ps1 — 启动本地服务 + 公网 HTTPS 隧道，打印可分享网址和二维码。
# 用法：powershell -ExecutionPolicy Bypass -File tools\share.ps1 [-Port 4173]

param([int]$Port = 4173)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$cloudflared = 'E:\DSH\tools\cloudflared.exe'
$log = Join-Path $root 'shots\tunnel.log'

# 1) 本地静态服务
$listening = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
if (-not $listening) {
  Start-Process -FilePath 'node' -ArgumentList @('server.mjs', '--port', "$Port") -WorkingDirectory $root -WindowStyle Hidden
  Start-Sleep -Milliseconds 800
  Write-Host "本地服务已启动: http://127.0.0.1:$Port/"
} else {
  Write-Host "本地服务已在运行: http://127.0.0.1:$Port/"
}

# 2) 公网隧道（quick tunnel，无需账号）
$cf = Get-Process cloudflared -ErrorAction SilentlyContinue
if (-not $cf) {
  if (-not (Test-Path $cloudflared)) { throw "找不到 $cloudflared（先下载 cloudflared.exe）" }
  Start-Process -FilePath $cloudflared -ArgumentList @('tunnel', '--url', "http://127.0.0.1:$Port", '--no-autoupdate', '--logfile', $log) -WindowStyle Hidden
  Write-Host '隧道启动中…'
} else {
  Write-Host '隧道已在运行，复用现有地址'
}

# 3) 从日志里取网址
$url = $null
for ($i = 0; $i -lt 60; $i++) {
  if (Test-Path $log) {
    $m = Select-String -Path $log -Pattern 'https://[a-z0-9-]+\.trycloudflare\.com' | Select-Object -Last 1
    if ($m) { $url = $m.Matches[0].Value; break }
  }
  Start-Sleep -Milliseconds 500
}
if (-not $url) { throw "没拿到隧道地址，看日志：$log" }

Write-Host ''
Write-Host '  掌心宇宙 / PALM COSMOS' -ForegroundColor Cyan
Write-Host "  $url" -ForegroundColor White
Write-Host ''
Write-Host '  · 手机、电脑都能直接打开（摄像头需要 https，这个地址满足）' -ForegroundColor DarkGray
Write-Host '  · 关掉电脑或隧道进程，网址就失效；重开会换一个新地址' -ForegroundColor DarkGray

# 4) 二维码（手机扫码打开）
$py = 'C:\Users\II\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\python\python.exe'
if (Test-Path $py) {
  & $py (Join-Path $PSScriptRoot 'qr.py') $url (Join-Path $root 'shots\share-qr.png') | Out-Null
  Write-Host "  二维码: $root\shots\share-qr.png" -ForegroundColor DarkGray
}