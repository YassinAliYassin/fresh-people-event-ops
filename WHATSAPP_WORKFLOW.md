# WhatsApp Event Ops Workflow

## Overview
WhatsApp is the primary communication channel for Fresh People clients and staff. This workflow bridges WhatsApp messages to the Event Ops system and syncs everything to iPhone Calendar via Google Calendar.

## How it works
1. **Client/Staff sends WhatsApp message** with booking details.
2. **Message is pasted/received** by Hermes (manual paste or automated via SolidAI Gateway WhatsApp channel).
3. **Event Ops processes** the data (Staff allocation, ID generation).
4. **Google Calendar event generated** (copy-paste to iPhone or auto-sync).
5. **Deployment message sent back** to WhatsApp (Staff/Client).

## WhatsApp Message Format (Input)
Clients/staff can send this format via WhatsApp:

```
EVENT: Wedding Reception
CLIENT: Sarah M
DATE: 2026-07-20
TIME: 14:00
LOCATION: The Venue, Joburg
GUESTS: 150
STAFF_REQUIRED: 6
SERVICES: Waiters, Baristas, DJ
NOTES: VIP table needed
```

## iPhone Calendar Sync
The system generates a **Google Calendar format** event.
- **iPhone users**: Add Google Account in *Settings > Calendar > Accounts*.
- Events appear automatically on iPhone Calendar.
- Title: `{EVENT} – {CLIENT} – {STAFF_REQUIRED} Staff`
- Description includes all booking details.

## Automated Deployment to WhatsApp
After processing, the system outputs a **DEPLOYMENT MESSAGE** formatted for WhatsApp:

```
🚀 EVENT DEPLOYMENT
Event: Wedding Reception
Client: Sarah M
Date: 2026-07-20
Time: 14:00
Location: The Venue, Joburg
Team Leader: Mike
Staff: Mike, Alex, John, Sipho, Ben, David
Arrival Time: 13:00
Dress Code: All Black
```

Copy-paste this directly to the staff WhatsApp group.

## Integration with SolidAI Gateway
The SolidAI Gateway (`/home/yassin/solidai-gateway`) has `whatsapp-web.js` channel support.
- **Path**: `src/channels/WhatsAppChannel.js`
- **Status**: Code exists, needs activation.
- **Goal**: Auto-parse incoming WhatsApp messages and trigger Event Ops.

## Next Steps
1. Use manual paste method (active now).
2. Activate WhatsApp channel in SolidAI Gateway for automation.
3. Connect Google Calendar to iPhone for auto-sync.
