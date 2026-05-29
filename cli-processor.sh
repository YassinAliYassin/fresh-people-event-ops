#!/bin/bash
# Fresh People Event Ops - CLI Processor
# Usage: ./cli-processor.sh "EVENT:...\nCLIENT:...\n..."

MSG="$1"

if [ -z "$MSG" ]; then
    echo "Usage: $0 \"booking_message\""
    echo ""
    echo "Example:"
    echo './cli-processor.sh "EVENT: Wedding\nCLIENT: Sarah\nDATE: 12 June 2026\nTIME: 14:00\nLOCATION: Sandton\nSTAFF_REQUIRED: 6"'
    exit 1
fi

# Process via API
curl -s -X POST http://localhost:5555/process-booking \
  -H "Content-Type: application/json" \
  -d "{\"message\":\"$MSG\"}" | jq -r '.result' 2>/dev/null || \
curl -s -X POST http://localhost:5555/process-booking \
  -H "Content-Type: application/json" \
  -d "{\"message\":\"$MSG\"}"
