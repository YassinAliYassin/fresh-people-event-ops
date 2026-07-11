#!/bin/bash
# Cloudflare zone status check + cache purge helper.
# SECURITY: never hardcode the API token in source. Export it (or load from .env):
#   export CF_API_TOKEN="cfat_xxx"
#   export CF_ZONE_ID="your_zone_id"
# This script refuses to run if the token is missing.

set -euo pipefail

# Resolve repo root from this script's location (works inside a git worktree too)
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="${PROJECT_ROOT:-$SCRIPT_DIR}"

# Load .env if present (optional)
if [ -f "$PROJECT_ROOT/.env" ]; then
  set -a
  # shellcheck disable=SC1090
  . "$PROJECT_ROOT/.env"
  set +a
fi

CF_API_TOKEN="${CF_API_TOKEN:-}"
CF_ZONE_ID="${CF_ZONE_ID:-}"

if [ -z "$CF_API_TOKEN" ] || [ -z "$CF_ZONE_ID" ]; then
  echo "ERROR: CF_API_TOKEN and CF_ZONE_ID must be set (export them or add to .env)." >&2
  exit 1
fi

RESPONSE=$(curl -s \
  -H "Authorization: Bearer ${CF_API_TOKEN}" \
  -H "Content-Type: application/json" \
  "https://api.cloudflare.com/client/v4/zones/${CF_ZONE_ID}")

echo "$RESPONSE" | python3 -m json.tool

STATUS=$(echo "$RESPONSE" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('result',{}).get('status','unknown'))" 2>/dev/null)
echo "Status: $STATUS"

if [ "$STATUS" = "active" ]; then
  echo "=== Zone is active, purging cache ==="
  PURGE_RESPONSE=$(curl -s -X POST \
    "https://api.cloudflare.com/client/v4/zones/${CF_ZONE_ID}/purge_cache" \
    -H "Authorization: Bearer ${CF_API_TOKEN}" \
    -H "Content-Type: application/json" \
    --data '{"purge_everything": true}')
  echo "$PURGE_RESPONSE" | python3 -m json.tool

  echo "=== Waiting 30s for purge to take effect ==="
  sleep 30

  echo "=== Checking keywords in homepage ==="
  curl -s https://fresh-people.co.za | grep -i "keywords"
else
  echo "Zone status is not active (status: $STATUS). Skipping purge."
fi
