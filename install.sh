#!/bin/sh
# guan-lineage 一键安装（macOS / Linux）
#
#   ./install.sh            检查环境 → npm install → npm link → 自检
#   ./install.sh --crawl    安装后立即全量抓取（约 8 分钟，只读）
#
# 不会自动安装 Node / Python（需管理员权限且各发行版方式不同），缺失时给出安装提示。
set -eu

cd "$(dirname "$0")"

# 仅在终端中输出颜色
if [ -t 1 ]; then G='\033[32m' Y='\033[33m' R='\033[31m' N='\033[0m'; else G='' Y='' R='' N=''; fi
ok()   { printf "  ${G}✓${N} %s\n" "$1"; }
warn() { printf "  ${Y}!${N} %s\n" "$1"; }
die()  { printf "  ${R}✗${N} %s\n" "$1" >&2; exit 1; }

case "$(uname -s)" in
  Darwin) OS=macos ;;
  Linux)  OS=linux ;;
  *)      die "不支持的系统 $(uname -s)；Windows 请运行 install.cmd" ;;
esac

echo "[1/4] 检查运行环境"

if ! command -v node >/dev/null 2>&1; then
  [ "$OS" = macos ] && hint="brew install node" || hint="见 https://nodejs.org 或用 nvm：nvm install 22"
  die "未找到 Node.js（需 ≥ 22.13）。安装：$hint"
fi
node -e 'const [a,b]=process.versions.node.split(".").map(Number);process.exit(a>22||(a===22&&b>=13)?0:1)' \
  || die "Node.js 版本 $(node -v) 过低，需 ≥ 22.13（内置 node:sqlite）"
ok "Node.js $(node -v)"

PY=""
for c in python3 python; do
  if command -v "$c" >/dev/null 2>&1 && "$c" -c 'import sys; sys.exit(sys.version_info < (3, 8))' 2>/dev/null; then
    PY=$c; break
  fi
done
if [ -z "$PY" ]; then
  [ "$OS" = macos ] && hint="brew install python" || hint="sudo apt install python3 或 sudo dnf install python3"
  die "未找到 Python ≥ 3.8。安装：$hint"
fi
ok "Python $("$PY" -c 'import platform; print(platform.python_version())')（$PY）"

# guancli / guands 只有抓取需要，缺失或未登录不阻断安装
if command -v guancli >/dev/null 2>&1 && command -v guands >/dev/null 2>&1; then
  ok "guancli $(guancli version 2>/dev/null) · guands $(guands version 2>/dev/null)"
  if guancli status >/dev/null 2>&1; then ok "guancli 已登录（API 连接正常）"
  else warn "guancli 未登录或连接失败：抓取前运行 guancli auth login，再用 guancli status 确认"; fi
else
  warn "未找到 guancli / guands：查询本地血缘不受影响，但 guanlineage crawl 需要它们。安装：
      npm install -g --foreground-scripts @guandata/guanskill && guancli auth login"
fi

echo "[2/4] 安装依赖（npm install）"
npm install --no-fund --no-audit

echo "[3/4] 注册全局命令 guanlineage（npm link）"
if ! npm link --no-fund --no-audit; then
  die "npm link 失败（通常是全局目录无写权限）。可改用用户目录：
      npm config set prefix ~/.npm-global && export PATH=~/.npm-global/bin:\$PATH
    并把 export 那一行写入 ~/.zshrc 或 ~/.bashrc，然后重新运行 ./install.sh"
fi

echo "[4/4] 自检"
if command -v guanlineage >/dev/null 2>&1; then
  guanlineage help >/dev/null && ok "guanlineage 可用：$(command -v guanlineage)"
else
  warn "guanlineage 已安装到 $(npm prefix -g)/bin，但该目录不在 PATH 中；请将其加入 PATH 后重开终端"
fi

DATA="${GUAN_LINEAGE_DATA:-$(pwd)/data}"
if [ "${1:-}" = "--crawl" ]; then
  guanlineage crawl
elif [ -f "$DATA/lineage.db" ]; then
  ok "已有血缘库 $DATA/lineage.db"
  echo; echo "完成。试试：guanlineage stats   或   guanlineage serve 后打开 http://localhost:4000/"
else
  echo; echo "完成。下一步：guanlineage crawl（约 8 分钟，只读抓取观远）生成血缘库，然后 guanlineage stats"
fi
