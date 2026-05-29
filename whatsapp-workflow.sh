#!/bin/bash
# Fresh People WhatsApp Workflow
TOKEN="EAAvYl97Mh2QBRu6ZBrhFzaxUmjTmSqazv7RskpKvdar5GLy7v0ZAHtuOnwjPf9irD7zhYF2Du4EbdIheD7pUx7lUnZAZCI5iuOmQZAd0nR6HZBoZAifKvCkxBwzQFpbnyJ1OeLZBmsLylYQqz4R1gUdr5LJVMPMlihTW2u8v06Hb9zXMZC8RSauZCZARpQ4fgnuQE0etQZDZD"
PHONE_NUMBER_ID="1190600000792870"
EVENT_PROCESSOR="/home/yassin/fresh-people-event-ops/event_processor.py"

BOOKING_MSG="$1"

if [ -z "$BOOKING_MSG" ]; then
    echo "Usage: $0 'EVENT: ...\nCLIENT: ...'"
    exit 1
fi

echo "📩 Processing booking..."
TEMP_FILE="/tmp/fp_booking_$(date +%s).txt"
echo -e "$BOOKING_MSG" > "$TEMP_FILE"

PROCESSING_OUTPUT=$(python3 "$EVENT_PROCESSOR" "$TEMP_FILE" 2>&1)

EVENT_ID=$(echo "$PROCESSING_OUTPUT" | grep -oP 'FP-\d{8}-[A-Z0-9]{4}' | head -1)
CLIENT=$(echo "$BOOKING_MSG" | grep -oP 'CLIENT:\s*\K.+' | head -1)
EVENT=$(echo "$BOOKING_MSG" | grep -oP 'EVENT:\s*\K.+' | head -1)
DATE=$(echo "$BOOKING_MSG" | grep -oP 'DATE:\s*\K.+' | head -1)
STAFF=$(echo "$PROCESSING_OUTPUT" | grep "Staff:" | head -1 | sed 's/.*Staff: //')

echo "✅ Processed! Event ID: $EVENT_ID"

WA_MESSAGE="🚀 EVENT CONFIRMED

Event: $EVENT
Client: $CLIENT
Date: $DATE
Event ID: $EVENT_ID

👥 Staff: $STAFF

📍 Arrival: 1hr before
👔 Dress: All Black

Fresh People Event Ops"

echo "📱 Sending WhatsApp..."
RESPONSE=$(curl -s -X POST "https://graph.facebook.com/v18.0/${PHONE_NUMBER_ID}/messages" \
  -H "Authorization: Bearer ${TOKEN}" \
  -H "Content-Type: application/json" \
  -d "{\"messaging_product\":\"whatsapp\",\"to\":\"27672961272\",\"type\":\"text\",\"text\":{\"body\":$(echo "$WA_MESSAGE" | jq -Rs .)}}")

MSG_ID=$(echo "$RESPONSE" | jq -r '.messages[0].id // .error.message')
if [[ "$MSG_ID" == wamid.* ]]; then
    echo "✅ Sent! ID: $MSG_ID"
else
    echo "❌ Error: $MSG_ID"
fi

rm -f "$TEMP_FILE"
echo "🎉 Done!"
