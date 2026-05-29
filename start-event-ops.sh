#!/bin/bash
# Fresh People Event Ops - Complete Startup Script
# Starts all services needed for event operations

echo "🚀 Starting Fresh People Event Operations System..."

# Kill existing processes
pkill -f "node server.js" 2>/dev/null
pkill -f "whatsapp-api-bot.js" 2>/dev/null
sleep 2

# Start WhatsApp API Bot (Meta API based)
echo "📱 Starting WhatsApp API Bot..."
cd /home/yassin/fresh-people-event-ops
nohup node whatsapp-api-bot.js > /tmp/whatsapp-api-bot.log 2>&1 &
echo "   ✓ WhatsApp Bot PID: $!"

# Start Event Ops Web Dashboard
echo "🌐 Starting Web Dashboard..."
cd /home/yassin/fresh-people-event-ops/web-dashboard
nohup node server.js > /tmp/event-ops-web.log 2>&1 &
echo "   ✓ Web Dashboard PID: $!"
echo "   → URL: http://197.185.136.142:3004"

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
echo "   • Web Dashboard: http://197.185.136.142:3004"
echo "   • WhatsApp Bot: http://197.185.136.142:3003"
echo ""
echo "📱 To link WhatsApp Bot:"
echo "   1. Configure webhook in Meta Dashboard"
echo "   2. Webhook URL: http://197.185.136.142:3003/webhook"
echo "   3. Verify Token: fresh_people_webhook_verify_2026"
