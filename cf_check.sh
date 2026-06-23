#!/bin/bash
TOKEN="cfat...RESPONSE=$(curl -s -H "Authorization: Bearer *** -H "Content-Type: application/json" "https://api.cloudflare.com/client/v4/zones/$ZONE_ID")
echo "$RESPONSE" | python3 -m json.tool

STATUS=$(echo "$RESPONSE" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('result',{}).get('status','unknown'))" 2>/dev/null)
echo "Status: $STATUS"

if [ "$STATUS" = "active" ]; then
    echo "=== Zone is active, purging cache ==="
    PURGE_RESPONSE=$(curl -s -X POST "https://api.cloudflare.com/client/v4/zones/$ZONE_ID/purge_cache" \
        -H "Authorization: Bearer *** \
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
