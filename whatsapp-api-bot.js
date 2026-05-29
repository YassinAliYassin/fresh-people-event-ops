const axios = require('axios');
const { exec } = require('child_process');
const fs = require('fs');
const path = require('path');

// CONFIG — Fill these after getting token
const ACCESS_TOKEN = 'EAAvYl97Mh2QBRu6ZBrhFzaxUmjTmSqazv7RskpKvdar5GLy7v0ZAHtuOnwjPf9irD7zhYF2Du4EbdIheD7pUx7lUnZAZCI5iuOmQZAd0nR6HZBoZAifKvCkxBwzQFpbnyJ1OeLZBmsLylYQqz4R1gUdr5LJVMPMlihTW2u8v06Hb9zXMZC8RSauZCZARpQ4fgnuQE0etQZDZD';
const PHONE_NUMBER_ID = '1190600000792870'; // From send-whatsapp.sh (WORKING)
// Display Phone Number: +27 67 296 1272 (Fresh People Business Number)
const VERIFY_TOKEN = 'fresh_people_webhook_verify_2026';

const EVENT_PROCESSOR = '/home/yassin/fresh-people-event-ops/event_processor.py';
const PORT = 3003;

const express = require('express');
const app = express();
app.use(express.json());

// Webhook verification (Meta requires this)
app.get('/webhook', (req, res) => {
    const mode = req.query['hub.mode'];
    const token = req.query['hub.verify_token'];
    const challenge = req.query['hub.challenge'];
    
    if (mode === 'subscribe' && token === VERIFY_TOKEN) {
        console.log('✅ Webhook verified!');
        res.status(200).send(challenge);
    } else {
        res.status(403).send('Verification failed');
    }
});

// Receive messages
app.post('/webhook', async (req, res) => {
    const body = req.body;
    
    if (body.object === 'whatsapp_business_account') {
        body.entry?.forEach(entry => {
            entry.changes?.forEach(change => {
                if (change.field === 'messages') {
                    const message = change.value.messages?.[0];
                    const from = message?.from;
                    const text = message?.text?.body;
                    
                    if (text && from) {
                        console.log(`📩 Message from ${from}: ${text.substring(0, 50)}...`);
                        handleBookingMessage(text, from);
                    }
                }
            });
        });
    }
    
    res.status(200).send('OK');
});

async function handleBookingMessage(text, from) {
    // Check if message has booking format
    if (!text.includes('EVENT:')) {
        await sendMessage(from, '📋 Send booking in format:\n\nEVENT: ...\nCLIENT: ...\nDATE: ...\nTIME: ...\nLOCATION: ...\nSTAFF_REQUIRED: ...');
        return;
    }
    
    // Process with Python
    const proc = exec(`echo "${text.replace(/"/g, '\\"')}" | python3 ${EVENT_PROCESSOR}`, 
        (error, stdout, stderr) => {
            if (error) {
                console.error('Processing error:', stderr);
                sendMessage(from, '❌ Error processing booking.');
                return;
            }
            
            // Extract deployment message and send
            const deploymentMatch = stdout.match(/E\. DEPLOYMENT MESSAGE[\s\S]+$/);
            if (deploymentMatch) {
                sendMessage(from, deploymentMatch[0]);
            }
        }
    );
}

async function sendMessage(to, message) {
    if (ACCESS_TOKEN === 'PASTE_YOUR_TOKEN_HERE') {
        console.log('⚠️ No access token configured!');
        return;
    }
    
    try {
        const response = await axios.post(
            `https://graph.facebook.com/v18.0/${PHONE_NUMBER_ID}/messages`,
            {
                messaging_product: 'whatsapp',
                to: to,
                text: { body: message }
            },
            {
                headers: {
                    'Authorization': `Bearer ${ACCESS_TOKEN}`,
                    'Content-Type': 'application/json'
                }
            }
        );
        console.log('✅ Message sent:', response.data.messages?.[0]?.id);
    } catch (error) {
        console.error('❌ Send error:', error.response?.data || error.message);
    }
}

// Web form booking processor
app.post('/process-booking-whatsapp', express.json(), (req, res) => {
  const { message } = req.body;
  if (!message) return res.status(400).json({ success: false, error: 'No booking message' });
  
  const script = path.join(__dirname, 'whatsapp-workflow-v2.sh');
  
  exec(`bash "${script}" "${message.replace(/"/g, '\\"')}"`, { cwd: __dirname }, (err, stdout, stderr) => {
    if (err) return res.status(500).json({ success: false, error: stderr });
    res.json({ success: true, result: stdout });
  });
});

app.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 WhatsApp API Bot running on port ${PORT}`);
    console.log(`📩 Webhook URL: http://YOUR_SERVER:${PORT}/webhook`);
    console.log(`🔑 Verify Token: ${VERIFY_TOKEN}`);
});
