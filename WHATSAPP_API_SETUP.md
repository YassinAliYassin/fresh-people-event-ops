# WhatsApp Business API - Quick Setup

## 1. Get Access Token (5 mins)
1. Go: https://developers.facebook.com/apps/1611434223269881/
2. Click: **WhatsApp > API Setup** (left sidebar)
3. Under "Send or receive messages":
   - Copy **Temporary access token** (expires in ~60 mins, can regenerate)
   - Note your **Phone number ID** (looks like: 1234567890123456)
   - Verify phone number is added (can send from this number)

## 2. Configure Bot
Edit `/home/yassin/fresh-people-event-ops/whatsapp-api-bot.js`:
```javascript
const ACCESS_TOKEN = 'EAABwz...your_actual_token...';  // From step 1
const PHONE_NUMBER_ID = '1234567890123456';  // Your Phone Number ID
```

## 3. Start Bot
```bash
cd /home/yassin/fresh-people-event-ops
pm2 start whatsapp-api-bot.js --name fresh-people-api-bot
pm2 save
```

## 4. Setup Webhook (Meta needs to reach your server)
**Option A — If server has public IP**:
- Webhook URL: `http://YOUR_PUBLIC_IP:3003/webhook`
- Verify Token: `fresh-people-verify-token-12345`

**Option B — Use localtunnel for testing**:
```bash
npx localtunnel --port 3003
# Use the URL it gives you as webhook URL
```

## 5. Test
Send booking message to your WhatsApp Business number:
```
EVENT: Test
CLIENT: Test Client
DATE: 2026-05-25
TIME: 14:00-16:00
LOCATION: Test Venue
STAFF_REQUIRED: 2
```

Bot will reply with full deployment message!

## Notes
- Token expires in ~60 mins (regenerate from Meta portal)
- For production: Use permanent token (requires App Review)
- Costs: Free tier = 1000 msgs/month, then paid
