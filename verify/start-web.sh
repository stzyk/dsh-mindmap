#!/usr/bin/env bash
# 隔离验证：在 web profile 上起 3099 端口的 dsh web（不触碰 desktop-web / 3080）。
#
# 用法：
#   bash verify/start-web.sh            # 前台启动（Ctrl-C 停）
#   bash verify/start-web.sh --bg       # 后台启动，日志落 verify/dsh-web-<port>.log
#
# 产出：
#   verify/dsh-web-<port>.log   启动日志（含带 token 的 URL）
#   verify/web<port>.pid        后台模式下的进程 PID
set -uo pipefail

PORT=${PORT:-3099}
PROFILE=${PROFILE:-web}
ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
LOG="$ROOT/verify/dsh-web-$PORT.log"
PIDFILE="$ROOT/verify/web$PORT.pid"

mkdir -p "$ROOT/verify"

# 端口预检：被占用就直接退出，避免误杀别人的进程
if lsof -nP -iTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1; then
  echo "[start-web] 端口 $PORT 已被占用，先确认是不是自己的实例：" >&2
  lsof -nP -iTCP:"$PORT" -sTCP:LISTEN >&2
  exit 1
fi

cd "$HOME/.dsh/profiles/$PROFILE" || exit 1

if [ "${1:-}" = "--bg" ]; then
  : > "$LOG"
  nohup /Users/mumu/.npm-global/bin/dsh --profile "$PROFILE" --port "$PORT" --no-open \
    >> "$LOG" 2>&1 &
  echo $! > "$PIDFILE"
  echo "[start-web] 后台启动 PID=$(cat "$PIDFILE")，日志：$LOG"
  for _ in $(seq 1 180); do
    URL=$(grep -oE "http://[^ ]*token=[A-Za-z0-9_-]+" "$LOG" | head -1)
    if [ -n "${URL:-}" ]; then
      echo "[start-web] 就绪：$URL"
      exit 0
    fi
    sleep 0.5
  done
  echo "[start-web] 启动超时，看日志：$LOG" >&2
  tail -40 "$LOG" >&2
  exit 1
else
  exec /Users/mumu/.npm-global/bin/dsh --profile "$PROFILE" --port "$PORT" --no-open 2>&1 | tee "$LOG"
fi
