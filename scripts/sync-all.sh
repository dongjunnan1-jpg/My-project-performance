#!/usr/bin/env bash
# 一键同步：本地 index.html → GitHub main → 腾讯云 turbo-1 / helium-d，并核对四方哈希
#
#   ./scripts/sync-all.sh          推送 + 上传 + 核对
#   ./scripts/sync-all.sh --check  只读核对，不改任何东西
#
# 退出码：0 全部一致；1 核对不一致；2 前置条件不满足
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT" || exit 1
export PATH="/Users/helium/.workbuddy/binaries/node/cli-connector-packages/bin:$PATH"

FILE="index.html"
GH_REPO="dongjunnan1-jpg/My-project-performance"
ENV_ID="helium-d3gmru2j0ff7b83c3"
DIRS=("turbo-1" "helium-d")
URLS=(
  "https://turbo-1-helium-d3gmru2j0ff7b83c3.webapps.tcloudbase.com/"
  "https://helium-d-helium-d3gmru2j0ff7b83c3.webapps.tcloudbase.com/"
  "https://helium-d3gmru2j0ff7b83c3-1487211746.tcloudbaseapp.com/turbo-1/index.html"
  "https://helium-d3gmru2j0ff7b83c3-1487211746.tcloudbaseapp.com/helium-d/index.html"
)

CHECK_ONLY=0
[ "${1:-}" = "--check" ] && CHECK_ONLY=1

say() { printf '\n\033[1m%s\033[0m\n' "$*"; }
ok()  { printf '  \033[32m✓\033[0m %s\n' "$*"; }
bad() { printf '  \033[31m✗\033[0m %s\n' "$*"; }
sha_file() { shasum -a 256 "$1" | cut -d' ' -f1; }
sha_url()  { curl -sS --max-time 60 --retry 2 "$1?v=$(date +%s)" | shasum -a 256 | cut -d' ' -f1; }

LOCAL_SHA="$(sha_file "$FILE")"
say "本地"
printf '  %s  %s bytes\n' "$LOCAL_SHA" "$(stat -f %z "$FILE")"

# ---------- 推送 GitHub ----------
if [ "$CHECK_ONLY" = 0 ]; then
  say "GitHub 推送"
  if [ -n "$(git status --porcelain -- "$FILE")" ]; then
    bad "$FILE 有未提交改动。先 git commit 再同步（脚本不自动提交，避免混进别的东西）"
    exit 2
  fi
  LOCAL_HEAD="$(git rev-parse HEAD)"
  REMOTE_HEAD="$(gh api "repos/$GH_REPO/git/ref/heads/main" --jq '.object.sha' 2>/dev/null)"
  if [ -z "$REMOTE_HEAD" ]; then
    bad "读不到远端 main（gh 未登录或网络不通）"
    exit 2
  fi
  if [ "$LOCAL_HEAD" = "$REMOTE_HEAD" ]; then
    ok "远端 main 已是 ${LOCAL_HEAD}（跳过）"
  else
    printf '  本地 %s → 远端 %s\n' "${LOCAL_HEAD:0:8}" "${REMOTE_HEAD:0:8}"
    if GIT_TERMINAL_PROMPT=0 timeout 45 git push origin main >/dev/null 2>&1; then
      ok "git push 成功"
    else
      printf '  git push 不通（代理常返回 502），改走 Git Data API\n'
      if /opt/homebrew/bin/python3 scripts/gh_push_api.py --repo "$GH_REPO" --file "$FILE"; then
        ok "API 推送成功"
      else
        bad "API 推送失败"; exit 2
      fi
    fi
  fi
fi

# ---------- 上传腾讯云 ----------
if [ "$CHECK_ONLY" = 0 ]; then
  say "腾讯云静态托管上传"
  for d in "${DIRS[@]}"; do
    out="$(timeout 180 tcb hosting deploy "$FILE" "$d" -e "$ENV_ID" --json 2>&1)"
    if printf '%s' "$out" | grep -q '"successCount": 1'; then
      ok "$d/index.html 上传成功"
    else
      bad "$d 上传失败：$(printf '%s' "$out" | tail -3)"
    fi
  done
fi

# ---------- 四方核对 ----------
say "一致性核对"
FAIL=0

# GitHub：从远端 main 的 tree 定位 index.html 的 blob，取回内容算 sha256
REMOTE_MAIN="$(gh api "repos/$GH_REPO/git/ref/heads/main" --jq '.object.sha' 2>/dev/null)"
GH_SHA=""
if [ -n "$REMOTE_MAIN" ]; then
  ROOT_TREE="$(gh api "repos/$GH_REPO/git/commits/$REMOTE_MAIN" --jq '.tree.sha' 2>/dev/null)"
  BLOB="$(gh api "repos/$GH_REPO/git/trees/$ROOT_TREE" --jq ".tree[] | select(.path==\"$FILE\") | .sha" 2>/dev/null)"
  [ -n "$BLOB" ] && GH_SHA="$(gh api "repos/$GH_REPO/git/blobs/$BLOB" --jq '.content' 2>/dev/null | tr -d '\n' | base64 -d | shasum -a 256 | cut -d' ' -f1)"
fi
printf '  %-12s %s\n' "本地" "$LOCAL_SHA"
if [ -n "$GH_SHA" ]; then
  printf '  %-12s %s\n' "GitHub" "$GH_SHA"
  if [ "$GH_SHA" = "$LOCAL_SHA" ]; then ok "GitHub == 本地"; else bad "GitHub != 本地"; FAIL=1; fi
else
  bad "读不到 GitHub 上的 $FILE"; FAIL=1
fi

i=0
for u in "${URLS[@]}"; do
  i=$((i+1))
  h="$(sha_url "$u")"
  host="$(printf '%s' "$u" | sed -E 's#https://([^/]+).*#\1#')"
  printf '  %-12s %s  (%s)\n' "线上$i" "$h" "$host"
  if [ "$h" = "$LOCAL_SHA" ]; then ok "线上$i == 本地"; else bad "线上$i != 本地"; FAIL=1; fi
done

say "结论"
if [ "$FAIL" = 0 ]; then
  printf '  \033[32m全部一致\033[0m：本地 / GitHub / 腾讯云 4 个入口同哈希 %s\n' "${LOCAL_SHA:0:12}"
else
  printf '  \033[31m存在不一致\033[0m，见上面标 ✗ 的项\n'
fi
exit "$FAIL"
