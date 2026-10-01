#Requires -RunAsAdministrator
<#
.SYNOPSIS
  卸载 SSIO Windows 服务（只摘服务，不动数据）。

.DESCRIPTION
  服务移除后 data/ 目录原样保留 —— 卸载脚本绝不删用户数据。
  要连数据一起清，自己删目录（或先跑 pnpm backup 留一份）。
#>
param(
  [string]$ServiceName = 'ssio'
)

$ErrorActionPreference = 'Stop'

if (-not (Get-Service $ServiceName -ErrorAction SilentlyContinue)) {
  Write-Host "[ssio] 服务 $ServiceName 不存在，无需卸载"
  exit 0
}

$nssm = (Get-Command nssm -ErrorAction SilentlyContinue).Source
if (-not $nssm) { Write-Host '[ssio] 找不到 nssm.exe' -ForegroundColor Red; exit 1 }

& $nssm stop $ServiceName confirm | Out-Null
& $nssm remove $ServiceName confirm | Out-Null

Write-Host "[ssio] 服务已移除。数据目录未动（如需清理请自行删除）" -ForegroundColor Green
