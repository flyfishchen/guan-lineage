# guan-lineage 一键安装（Windows）
#
#   双击 install.cmd，或在 PowerShell 中：  .\install.ps1 [-Crawl] [-NoSkill]
#   -Crawl    安装后立即全量抓取（约 8 分钟，只读）
#   -NoSkill  不安装 AI skill
#
# 不会自动安装 Node / Python，缺失时给出安装提示。
# 注意：本文件须保存为 UTF-8 with BOM，否则 Windows PowerShell 5.1 会把中文读成乱码。
param([switch]$Crawl, [switch]$NoSkill)

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.Encoding]::UTF8
Set-Location -LiteralPath $PSScriptRoot

function Ok($m)   { Write-Host "  [OK] $m" -ForegroundColor Green }
function Warn($m) { Write-Host "  [!]  $m" -ForegroundColor Yellow }
function Die($m)  { Write-Host "  [X]  $m" -ForegroundColor Red; exit 1 }
function Has($c)  { [bool](Get-Command $c -ErrorAction SilentlyContinue) }

Write-Host '[1/5] 检查运行环境'

if (-not (Has node)) { Die '未找到 Node.js（需 ≥ 22.13）。安装：winget install OpenJS.NodeJS.LTS，或从 https://nodejs.org 下载，装完重开终端' }
# JS 内不用双引号：Windows PowerShell 5.1 向外部程序传参时会吞掉双引号
node -e 'const [a,b]=process.versions.node.split(''.'').map(Number);process.exit(a>22||(a===22&&b>=13)?0:1)'
if ($LASTEXITCODE -ne 0) { Die "Node.js 版本 $(node -v) 过低，需 ≥ 22.13（内置 node:sqlite）" }
Ok "Node.js $(node -v)"

# 与 bin/guanlineage.mjs 的 findPython() 顺序一致
$py = $null
foreach ($cand in @(@('py', '-3'), @('python'), @('python3'))) {
  if (-not (Has $cand[0])) { continue }
  $pre = @($cand | Select-Object -Skip 1)
  # 跳过 Microsoft Store 的 python 占位程序（运行会失败）
  & $cand[0] @pre -c 'import sys; sys.exit(sys.version_info < (3, 8))' 2>$null
  if ($LASTEXITCODE -eq 0) { $py = $cand; break }
}
if (-not $py) { Die '未找到 Python ≥ 3.8。安装：winget install Python.Python.3.12，或从 https://www.python.org 下载（勾选 Add to PATH）' }
$pyPre = @($py | Select-Object -Skip 1)
Ok "Python $(& $py[0] @pyPre -c 'import platform; print(platform.python_version())')（$($py -join ' ')）"

# guancli / guands 只有抓取需要，缺失或未登录不阻断安装
if ((Has guancli) -and (Has guands)) {
  Ok "guancli $(guancli.cmd version 2>$null) · guands $(guands.cmd version 2>$null)"
  guancli.cmd status *> $null
  if ($LASTEXITCODE -eq 0) { Ok 'guancli 已登录（API 连接正常）' }
  else { Warn 'guancli 未登录或连接失败：抓取前运行 guancli auth login，再用 guancli status 确认' }
} else {
  Warn "未找到 guancli / guands：查询本地血缘不受影响，但 guanlineage crawl 需要它们。安装：`n       npm install -g --foreground-scripts @guandata/guanskill; guancli auth login"
}

# npm.cmd：避免 npm.ps1 受执行策略限制
Write-Host '[2/5] 安装依赖（npm install）'
npm.cmd install --no-fund --no-audit
if ($LASTEXITCODE -ne 0) { Die 'npm install 失败，见上方输出' }

Write-Host '[3/5] 注册全局命令 guanlineage（npm link）'
npm.cmd link --no-fund --no-audit
if ($LASTEXITCODE -ne 0) { Die 'npm link 失败，见上方输出' }

Write-Host '[4/5] 自检'
$prefix = (npm.cmd prefix -g).Trim()
# 当前会话的 PATH 可能还没有 npm 全局目录（刚装 Node 时常见）
if (-not (Has guanlineage) -and ($env:Path -split ';') -notcontains $prefix) { $env:Path = "$prefix;$env:Path" }
if (Has guanlineage) {
  guanlineage.cmd help | Out-Null
  Ok "guanlineage 可用：$((Get-Command guanlineage).Source)"
} else {
  Warn "guanlineage 已安装到 $prefix，但该目录不在 PATH 中；请将其加入系统 PATH 后重开终端"
}

Write-Host '[5/5] 安装 AI skill（让 AI 助手在对话中直接查询血缘）'
if ($NoSkill) {
  Ok '已跳过（-NoSkill）'
} else {
  # 直接用仓库内的 CLI，不依赖 PATH；失败不影响主程序使用
  node bin/guanlineage.mjs install-skill | ForEach-Object { "  $_" }
  if ($LASTEXITCODE -ne 0) { Warn 'AI skill 安装失败，可稍后运行 guanlineage install-skill 重试' }
}

$data = if ($env:GUAN_LINEAGE_DATA) { $env:GUAN_LINEAGE_DATA } else { Join-Path $PSScriptRoot 'data' }
if ($Crawl) {
  guanlineage.cmd crawl
} elseif (Test-Path (Join-Path $data 'lineage.db')) {
  Ok "已有血缘库 $(Join-Path $data 'lineage.db')"
  Write-Host "`n完成。试试：guanlineage stats   或   guanlineage serve 后打开 http://localhost:4000/"
} else {
  Write-Host "`n完成。下一步：guanlineage crawl（约 8 分钟，只读抓取观远）生成血缘库，然后 guanlineage stats"
}
