#!/bin/bash
# Fresh People Event Ops - Auto-Start Script
# Run both servers in background

# Resolve repo root from this script's location (works inside a git worktree too)
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="${PROJECT_ROOT:-$SCRIPT_DIR}"

echo "🚀 Starting Fresh People Event Ops..."

# Kill any existing processes
pkill -f "node.*server.js" 2>/dev/null
pkill -f "node.*whatsapp-api-bot.js" 2>/dev/null
sleep 1

# Start main server on port 5555
cd "$PROJECT_ROOT"
PORT=5555 nohup node server.js > /tmp/fresh-ops-main.log 2>&1 &
echo "✅ Main server starting on port 5555"

# Start WhatsApp API bot on port 3003
nohup node whatsapp-api-bot.js > /tmp/fresh-ops-bot.log 2>&1 &
echo "✅ WhatsApp API bot starting on port 3003"

sleep 2

# Verify
if lsof -i:5555 >/dev/null 2>&1; then
    echo "✅ Main server: http://localhost:5555/"
else
    echo "❌ Main server failed to start"
fi

if lsof -i:3003 >/dev/null 2>&1; then
    echo "✅ WhatsApp bot webhook: http://localhost:3003/webhook"
else
    echo "❌ WhatsApp bot failed to start"
fi

echo ""
echo "📱 Web Form: http://localhost:5555/"
echo "📩 Webhook URL: http://YOUR_SERVER_IP:3003/webhook"
echo "🔑 Verify Token: fresh_people_webhook_verify_2026"
