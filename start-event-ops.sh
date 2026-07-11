#!/bin/bash
# Fresh People Event Ops - Complete Startup Script
# Starts all services needed for event operations.
#
# Resolves the repo root from PROJECT_ROOT (env) or this script's location,
# matching the convention used by ecosystem.config.js (PM2). This keeps the
# script safe to run from a git worktree, not just the canonical checkout.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="${PROJECT_ROOT:-$SCRIPT_DIR}"

echo "🚀 Starting Fresh People Event Operations System..."
echo "   Repo root: $PROJECT_ROOT"

# Kill existing processes.
# Note: the canonical dashboard is server-v4.js (matches PM2/ecosystem.config.js
# on PORT 3004). We also kill the legacy web-dashboard/server.js to avoid a
# port-3004 collision if it was started by an older script.
pkill -f "node.*server-v4.js" 2>/dev/null
pkill -f "node.*web-dashboard/server.js" 2>/dev/null
pkill -f "whatsapp-api-bot.js" 2>/dev/null
sleep 2

# Start WhatsApp API Bot (Meta API based)
echo "📱 Starting WhatsApp API Bot..."
cd "$PROJECT_ROOT"
nohup node whatsapp-api-bot.js > /tmp/whatsapp-api-bot.log 2>&1 &
echo "   ✓ WhatsApp Bot PID: $!"

# Start Event Ops Web Dashboard (canonical server-v4.js, PORT 3004)
echo "🌐 Starting Web Dashboard..."
cd "$PROJECT_ROOT/web-dashboard"
PORT=3004 nohup node server-v4.js > /tmp/event-ops-web.log 2>&1 &
echo "   ✓ Web Dashboard PID: $!"
echo "   → URL: http://localhost:3004"

sleep 3

# Health checks
echo ""
echo "🔍 Health Checks:"
if curl -s http://localhost:3003/health 2>/dev/null | grep -q "ok"; then
    echo "   ✓ WhatsApp Bot: ONLINE"
else
    echo "   ⚠️  WhatsApp Bot: Not responding (check /tmp/whatsapp-api-bot.log)"
fi

if curl -s http://localhost:3004/api/events >/dev/null 2>&1; then
    echo "   ✓ Web Dashboard: ONLINE"
else
    echo "   ⚠️  Web Dashboard: Not responding (check /tmp/event-ops-web.log)"
fi

echo ""
echo "✅ Fresh People Event Ops System is READY!"
echo ""
echo "📋 Access Points:"
echo "   • Web Dashboard: http://localhost:3004"
echo "   • WhatsApp Bot: http://localhost:3003"
echo ""
echo "📱 To link WhatsApp Bot:"
echo "   1. Configure webhook in Meta Dashboard"
echo "   2. Webhook URL: http://YOUR_SERVER:3003/webhook"
echo "   3. Verify Token: fresh_people_webhook_verify_2026"
