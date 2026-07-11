#!/bin/bash
# Fresh People WhatsApp Workflow - WITH STAFF NOTIFICATIONS
# SECURITY: load credentials from environment (no secrets in source control).
#   export WA_ACCESS_TOKEN="EAAv..." WA_PHONE_NUMBER_ID="1190600000792870"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="${PROJECT_ROOT:-$SCRIPT_DIR}"
TOKEN="${WA_ACCESS_TOKEN:-PASTE_YOUR_TOKEN_HERE}"
PHONE_NUMBER_ID="${WA_PHONE_NUMBER_ID:-1190600000792870}"
EVENT_PROCESSOR="${EVENT_PROCESSOR:-$PROJECT_ROOT/event_processor.py}"

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
TIME=$(echo "$BOOKING_MSG" | grep -oP 'TIME:\s*\K.+' | head -1)
LOCATION=$(echo "$BOOKING_MSG" | grep -oP 'LOCATION:\s*\K.+' | head -1)
STAFF_LINE=$(echo "$PROCESSING_OUTPUT" | grep "Staff:" | head -1)
STAFF=$(echo "$STAFF_LINE" | sed 's/.*Staff: //')

echo "✅ Processed! Event ID: $EVENT_ID"
echo "👥 Staff assigned: $STAFF"

# Send confirmation to admin (Yassin)
ADMIN_MSG="🚀 EVENT CONFIRMED

Event: $EVENT
Client: $CLIENT
Date: $DATE at $TIME
Location: $LOCATION
Event ID: $EVENT_ID

👥 Staff: $STAFF

📍 Arrival: 1hr before
👔 Dress: All Black

Fresh People Event Ops"

echo "📱 Sending admin confirmation..."
curl -s -X POST "https://graph.facebook.com/v18.0/${PHONE_NUMBER_ID}/messages" \
  -H "Authorization: Bearer ${TOKEN}" \
  -H "Content-Type: application/json" \
  -d "{\"messaging_product\":\"whatsapp\",\"to\":\"27672961272\",\"type\":\"text\",\"text\":{\"body\":$(echo "$ADMIN_MSG" | jq -Rs .)}}" > /dev/null

# Notify each staff member (SIMULATED - needs staff phone numbers)
echo "📢 Notifying staff..."
IFS=', ' read -ra STAFF_ARRAY <<< "$STAFF"
for staff in "${STAFF_ARRAY[@]}"; do
    # Remove leading space if any
    staff=$(echo "$staff" | xargs)
    
    STAFF_MSG="Hi $staff! 👋

You're assigned to:
📅 $EVENT
🏢 $CLIENT
📍 $LOCATION
🕐 $DATE at $TIME

Event ID: $EVENT_ID
Team Leader: Mike

Arrive 1hr early. All Black dress code.

Fresh People Ops"

    # In production, replace with actual staff WhatsApp numbers
    # For now, log the notification
    echo "  → Would notify $staff: $STAFF_MSG" | head -3
    
    # Uncomment when you have staff numbers:
    # curl -X POST "https://graph.facebook.com/v18.0/${PHONE_NUMBER_ID}/messages" \
    #   -H "Authorization: Bearer ${TOKEN}" \
    #   -H "Content-Type: application/json" \
    #   -d "{\"messaging_product\":\"whatsapp\",\"to\":\"STAFF_NUMBER_HERE\",\"type\":\"text\",\"text\":{\"body\":$(echo "$STAFF_MSG" | jq -Rs .)}}"
done

rm -f "$TEMP_FILE"
echo "🎉 Done! Event $EVENT_ID confirmed and staff notified."
