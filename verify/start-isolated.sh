#!/usr/bin/env bash
# 完全隔离的验证实例：独立 DSH_HOME，**不碰**用户 ~/.dsh 下的真实数据。
#
# 为什么需要：插件的存储路径是 $DSH_HOME/storages/，不按 profile 分。
# 直接起 3099 会和用户正在用的 3080 共用同一个 JSON 文件，
# 两个进程各有内存副本、谁保存谁覆盖对方——真实数据会丢。
#
# 用法：bash verify/start-isolated.sh [--bg]
set -uo pipefail

PORT=${PORT:-3099}
TESTHOME=${TESTHOME:-/tmp/dsh-verify-home}
ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
LOG="$ROOT/verify/dsh-web-$PORT.log"
PIDFILE="$ROOT/verify/web$PORT.pid"

mkdir -p "$ROOT/verify" "$TESTHOME/profiles"

if [ ! -d "$TESTHOME/profiles/web" ]; then
  echo "[start-isolated] 首次运行，准备隔离 profile…" >&2
  cp -R "$HOME/.dsh/profiles/web" "$TESTHOME/profiles/web"
  ln -sfn "$ROOT" "$TESTHOME/profiles/web/node_modules/dsh-mindmap"
fi

if lsof -nP -iTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1; then
  echo "[start-isolated] 端口 $PORT 已被占用" >&2
  lsof -nP -iTCP:"$PORT" -sTCP:LISTEN >&2
  exit 1
fi

cd "$TESTHOME/profiles/web" || exit 1

if [ "${1:-}" = "--bg" ]; then
  DSH_HOME="$TESTHOME" nohup dsh web --port "$PORT" >"$LOG" 2>&1 &
  echo $! > "$PIDFILE"
  for _ in $(seq 1 60); do
    sleep 0.5
    if grep -qE "http://[^ ]*token=" "$LOG" 2>/dev/null; then
      grep -oE "http://[^ ]*token=[A-Za-z0-9_-]+" "$LOG" | head -1 | sed 's/^/[start-isolated] 就绪：/'
      exit 0
    fi
  done
  echo "[start-isolated] 启动超时，看日志：$LOG" >&2
  tail -20 "$LOG" >&2
  exit 1
fi

DSH_HOME="$TESTHOME" exec dsh web --port "$PORT"
