#Requires -RunAsAdministrator
<#
.SYNOPSIS
  把 SSIO 注册成 Windows 服务（NSSM 托管）。

.DESCRIPTION
  Windows 没有 systemd，长时间跑的 Node 服务要么挂在登录会话里（一注销就没了），
  要么做成服务。这里用 NSSM（Non-Sucking Service Manager）托管 node.exe：
  服务随开机自启，崩溃自动重启，stdout/stderr 落到日志文件。

  前置：
    1. 已把仓库放到安装目录，并在该目录跑过：
         pnpm install --frozen-lockfile --prod --filter '@ssio/server...'
         pnpm --filter @ssio/shared --filter @ssio/server build
    2. NSSM 已就位：winget install NSSM.NSSM（或把 nssm.exe 放到 PATH）

.PARAMETER InstallDir
  SSIO 安装目录，默认当前目录。

.PARAMETER ServiceName
  服务名，默认 ssio。

.PARAMETER Port
  监听端口，默认 8100。

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File deploy\install-windows.ps1 -InstallDir C:\ssio
#>
param(
  [string]$InstallDir = (Get-Location).Path,
  [string]$ServiceName = 'ssio',
  [int]$Port = 8100
)

$ErrorActionPreference = 'Stop'

function Fail($msg) { Write-Host "[ssio] 失败: $msg" -ForegroundColor Red; exit 1 }

# ---- 1. NSSM ----
$nssm = (Get-Command nssm -ErrorAction SilentlyContinue).Source
if (-not $nssm) { Fail '找不到 nssm.exe。先装：winget install NSSM.NSSM，或把 nssm.exe 放进 PATH' }

# ---- 2. 安装目录与产物 ----
$entry = Join-Path $InstallDir 'packages/server/dist/index.js'
if (-not (Test-Path $entry)) { Fail "没找到 $entry 。先在 $InstallDir 里跑 pnpm install 与 pnpm build" }
$node = (Get-Command node).Source
if (-not $node) { Fail '找不到 node.exe' }

# ---- 3. 环境变量（写 .env，服务端启动时由 dotenv 读取）----
$envFile = Join-Path $InstallDir '.env'
if (-not (Test-Path $envFile)) {
  Write-Host "[ssio] 生成 .env 模板：$envFile" -ForegroundColor Yellow
  $rand = -join ((48..57) + (97..102) | Get-Random -Count 64 | ForEach-Object { [char]$_ })
  $mrand = -join ((48..57) + (97..102) | Get-Random -Count 32 | ForEach-Object { [char]$_ })
  @(
    "JWT_SECRET=$rand"
    "MASTER_KEY=$mrand"
    "DATA_DIR=$InstallDir\data"
    'HOST=127.0.0.1'
    "PORT=$Port"
    'LOG_LEVEL=info'
  ) | Set-Content -Path $envFile -Encoding utf8
  Write-Host '[ssio] 已随机生成 JWT_SECRET / MASTER_KEY —— 记下来，以后要用 Master Key 调管理接口' -ForegroundColor Yellow
} else {
  Write-Host "[ssio] 沿用已有 $envFile"
}

# ---- 4. 注册服务 ----
if (Get-Service $ServiceName -ErrorAction SilentlyContinue) {
  Write-Host "[ssio] 服务 $ServiceName 已存在，先移除再重建" -ForegroundColor Yellow
  & $nssm stop $ServiceName confirm | Out-Null
  & $nssm remove $ServiceName confirm | Out-Null
}

& $nssm install $ServiceName $node $entry | Out-Null
& $nssm set $ServiceName AppDirectory $InstallDir | Out-Null
& $nssm set $ServiceName DisplayName 'SSIO Server' | Out-Null
& $nssm set $ServiceName Description 'SSIO 自托管后端服务（发行 / 存储 / 发卡 / 公告）' | Out-Null
# 崩溃/退出都重启：服务型进程不该靠人盯着
& $nssm set $ServiceName AppExit Default Restart | Out-Null
& $nssm set $ServiceName AppRestartDelay 5000 | Out-Null
$logDir = Join-Path $InstallDir 'logs'
New-Item -ItemType Directory -Force -Path $logDir | Out-Null
& $nssm set $ServiceName AppStdout (Join-Path $logDir 'ssio.log') | Out-Null
& $nssm set $ServiceName AppStderr (Join-Path $logDir 'ssio.err.log') | Out-Null

Start-Service $ServiceName
Start-Sleep -Seconds 3

# ---- 5. 自检 ----
try {
  $r = Invoke-RestMethod -Uri "http://127.0.0.1:$Port/v1/readyz" -TimeoutSec 5
  Write-Host "[ssio] 服务已启动：readyz = $($r | ConvertTo-Json -Compress)" -ForegroundColor Green
} catch {
  Write-Host "[ssio] 服务已注册但自检没通过（看 $logDir\ssio.err.log）: $($_.Exception.Message)" -ForegroundColor Red
}

Write-Host "[ssio] 常用命令：Get-Service $ServiceName / Restart-Service $ServiceName / nssm edit $ServiceName"
