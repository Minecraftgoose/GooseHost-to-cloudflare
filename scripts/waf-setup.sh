#!/usr/bin/env bash
# =====================================================================
# GooseHost 边缘 WAF 限流规则（幂等，可重复执行）
#
# 用途：在 Worker 之前挡住 /api/* 的突发流量，连一次 Worker 调用都不产生。
# 免费版限制：只能有 1 条 rate limiting 规则、period=10s、
#             mitigation_timeout=10s、counting characteristics 只有 IP。
# 所以这条只是「外圈保险」，主限流在 Worker binding 与 Postgres 里。
#
# 由 .github/workflows/waf-setup.yml 手动触发调用；也可本地执行。
# 需要的环境变量：
#   CLOUDFLARE_API_TOKEN  — 需含 Zone WAF Write 或 Zone Rulesets Write 权限
#   CLOUDFLARE_ZONE_ID    — 站点 Zone ID（Dashboard 右下角可见）
#
# 依赖：curl + jq（GitHub ubuntu-latest runner 自带）
# =====================================================================
set -euo pipefail

: "${CLOUDFLARE_API_TOKEN:?缺少 CLOUDFLARE_API_TOKEN}"
: "${CLOUDFLARE_ZONE_ID:?缺少 CLOUDFLARE_ZONE_ID}"

API="https://api.cloudflare.com/client/v4"
RULE_DESC="GooseHost edge burst guard (managed by waf-setup.yml)"
HDR=(-H "Authorization: Bearer ${CLOUDFLARE_API_TOKEN}" -H "Content-Type: application/json")

# 免费版合规参数：只按 IP 计数、10s 窗口、10s 缓解期
RULE_JSON=$(cat <<'JSON'
{
  "description": "GooseHost edge burst guard (managed by waf-setup.yml)",
  "expression": "(starts_with(http.request.uri.path, \"/api/\"))",
  "action": "block",
  "ratelimit": {
    "characteristics": ["cf.colo.id", "ip.src"],
    "period": 10,
    "requests_per_period": 60,
    "mitigation_timeout": 10,
    "requests_to_origin": false
  },
  "enabled": true
}
JSON
)

check_ok() {
  local payload="$1" label="$2"
  local ok
  ok=$(printf '%s' "$payload" | jq -r '.success // false')
  if [ "$ok" != "true" ]; then
    echo "::error::${label} 失败：$(printf '%s' "$payload" | jq -c '.errors')"
    exit 1
  fi
}

echo "→ 查询 http_ratelimit 阶段入口 ruleset ..."
ENTRY=$(curl -sS "${HDR[@]}" \
  "$API/zones/${CLOUDFLARE_ZONE_ID}/rulesets/phases/http_ratelimit/entrypoint")
HTTP_HINT=$(printf '%s' "$ENTRY" | jq -r '.errors[0].code // empty')

if [ -n "$HTTP_HINT" ] && [ "$HTTP_HINT" != "null" ]; then
  echo "  入口 ruleset 不存在，创建（含限流规则）..."
  BODY=$(jq -n --argjson rule "$RULE_JSON" \
    '{kind:"root", name:"zone http_ratelimit entrypoint", phase:"http_ratelimit", rules:[$rule]}')
  OUT=$(curl -sS -X POST "${HDR[@]}" \
    "$API/zones/${CLOUDFLARE_ZONE_ID}/rulesets" -d "$BODY")
  check_ok "$OUT" "创建入口 ruleset"
  echo "✓ 已创建并部署边缘限流规则"
  exit 0
fi

RULESET_ID=$(printf '%s' "$ENTRY" | jq -r '.result.id // empty')
if [ -z "$RULESET_ID" ]; then
  echo "::error::无法解析入口 ruleset ID：$(printf '%s' "$ENTRY" | jq -c '.')"
  exit 1
fi

EXISTING_ID=$(printf '%s' "$ENTRY" | jq -r --arg d "$RULE_DESC" \
  '.result.rules[]? | select(.description == $d) | .id' | head -n1)

if [ -n "$EXISTING_ID" ]; then
  echo "  规则已存在（${EXISTING_ID}），更新为当前配置 ..."
  OUT=$(curl -sS -X PATCH "${HDR[@]}" \
    "$API/zones/${CLOUDFLARE_ZONE_ID}/rulesets/${RULESET_ID}/rules/${EXISTING_ID}" \
    -d "$RULE_JSON")
  check_ok "$OUT" "更新限流规则"
  echo "✓ 已更新边缘限流规则"
else
  echo "  入口 ruleset 存在（${RULESET_ID}），追加限流规则 ..."
  OUT=$(curl -sS -X POST "${HDR[@]}" \
    "$API/zones/${CLOUDFLARE_ZONE_ID}/rulesets/${RULESET_ID}/rules" \
    -d "$RULE_JSON")
  check_ok "$OUT" "新增限流规则"
  echo "✓ 已新增并部署边缘限流规则"
fi

echo
echo "提示：免费版只有 1 条限流规则配额。若 Dashboard 里另有规则占用，"
echo "      本脚本会新增失败并打印 API 错误，请先手动清理旧规则再重跑。"
