#!/usr/bin/env bash
# 停掉 verify/start-web.sh 起的后台实例。
set -uo pipefail

PORT=${PORT:-3099}
ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
PIDFILE="$ROOT/verify/web$PORT.pid"

if [ -f "$PIDFILE" ]; then
  PID=$(cat "$PIDFILE")
  if kill -0 "$PID" 2>/dev/null; then
    # 先 TERM 让 dsh 自己收尾（它会清理子进程），再兜底 KILL
    kill "$PID" 2>/dev/null
    for _ in $(seq 1 30); do
      kill -0 "$PID" 2>/dev/null || break
      sleep 0.2
    done
    kill -9 "$PID" 2>/dev/null
    echo "[stop-web] 已停止 PID=${PID}"
  else
    echo "[stop-web] PID=${PID} 已经不在跑了"
  fi
  rm -f "$PIDFILE"
else
  echo "[stop-web] 没有 ${PIDFILE}，跳过"
fi

# 端口还占着就报出来，不静默
if lsof -nP -iTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1; then
  echo "[stop-web] 警告：端口 ${PORT} 仍被占用" >&2
  lsof -nP -iTCP:"$PORT" -sTCP:LISTEN >&2
fi
