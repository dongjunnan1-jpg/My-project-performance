#!/usr/bin/env bash
# 代理自愈：检查 Shadowrocket 隧道是否还在干活，失效就重启隧道，再复核。
#
#   ./scripts/net-recover.sh          检查 → 必要时重启 → 复核（默认）
#   ./scripts/net-recover.sh --check  只检查，不动 VPN
#
# 背景（2026-11-07 实测）：系统代理 127.0.0.1:1082 端口一直是 LISTEN 的，
# 但隧道进程可能卡住 —— 此时「百度 200、Google/GitHub 全部 000」。
# 停掉再启动 VPN 服务即可恢复，**不需要换节点**。
#
# 退出码：0 代理可用；1 代理不可用（用完所有手段仍不通）
set -uo pipefail

CHECK_ONLY=0
[ "${1:-}" = "--check" ] && CHECK_ONLY=1

PROXY="http://127.0.0.1:1082"
TARGETS=("https://api.github.com/" "https://www.google.com/")

say() { printf '\n\033[1m%s\033[0m\n' "$*"; }
ok()  { printf '  \033[32m✓\033[0m %s\n' "$*"; }
bad() { printf '  \033[31m✗\033[0m %s\n' "$*"; }

code() { curl -s -o /dev/null --max-time 12 -x "$PROXY" -w '%{http_code}' "$1" 2>/dev/null; }

vpn_id() {
  scutil --nc list 2>/dev/null | grep -i 'Shadowrocket' | head -1 | sed -E 's/^[^(]*\(([^)]*)\).*/\1/'
}
vpn_state() {
  scutil --nc list 2>/dev/null | grep -i 'Shadowrocket' | head -1 | grep -q '(Connected)' && echo connected || echo disconnected
}

report() {
  local all_ok=0 c
  for u in "${TARGETS[@]}"; do
    c="$(code "$u")"
    # 200/301/302 都算通（google 会 302 到同意页）；000 = 连不上，这才是隧道卡住的特征
    case "$c" in
      2??|3??) ok "$(printf '%s' "$u") → $c" ;;
      *) bad "$(printf '%s' "$u") → ${c:-000}"; all_ok=1 ;;
    esac
  done
  return "$all_ok"
}

say "代理检查（${PROXY}）"
report && { echo; ok "代理正常，无需处理"; exit 0; }

if [ "$CHECK_ONLY" = 1 ]; then
  echo; bad "代理不通（--check 模式不改任何东西）"
  exit 1
fi

ID="$(vpn_id)"
if [ -z "$ID" ]; then
  bad "找不到 Shadowrocket 的 VPN 服务（scutil --nc list）"
  exit 1
fi

say "重启隧道"
printf '  服务 %s，当前状态 %s\n' "$ID" "$(vpn_state)"
scutil --nc stop "$ID" >/dev/null 2>&1
sleep 3
scutil --nc start "$ID" >/dev/null 2>&1 || { bad "启动失败"; exit 1; }
for _ in $(seq 1 20); do
  [ "$(vpn_state)" = "connected" ] && break
  sleep 1
done
[ "$(vpn_state)" = "connected" ] && ok "隧道已连接" || { bad "隧道未能连接"; exit 1; }
sleep 2

say "复核"
if report; then
  echo; ok "代理已恢复（本次没有换节点，只是隧道卡住）"
  exit 0
fi

echo
bad "重启隧道后仍不通 ⇒ 换节点：菜单栏 Shadowrocket → 选一个 Trojan 节点"
echo "  可连通列表：python3 scripts/node-scan.py"
exit 1
