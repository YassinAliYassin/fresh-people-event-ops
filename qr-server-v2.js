const express = require('express');
const fs = require('fs');
const QRCode = require('qrcode');
const path = require('path');

const app = express();
const PORT = 3002;

// Serve QR code page
app.get('/', async (req, res) => {
    const qrPath = '/tmp/whatsapp-qr.txt';
    
    if (!fs.existsSync(qrPath)) {
        return res.send(`
<!DOCTYPE html>
<html>
<head>
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Fresh People - WhatsApp QR</title>
    <style>
        body { font-family: sans-serif; padding: 20px; text-align: center; background: #f5f5f5; }
        .container { background: white; padding: 30px; border-radius: 10px; max-width: 500px; margin: 0 auto; }
        h1 { color: #A4C71D; }
        .status { padding: 20px; background: #fff3cd; border-radius: 5px; margin: 20px 0; }
    </style>
    <meta http-equiv="refresh" content="3">
</head>
<body>
    <div class="container">
        <h1>🚀 Fresh People WhatsApp Bot</h1>
        <div class="status">⏳ Waiting for QR code generation...</div>
        <p>This page auto-refreshes every 3 seconds.</p>
    </div>
</body>
</html>
        `);
    }
    
    try {
        const qrData = fs.readFileSync(qrPath, 'utf8').trim();
        const qrImage = await QRCode.toDataURL(qrData, { width: 300, margin: 2 });
        
        res.send(`
<!DOCTYPE html>
<html>
<head>
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Fresh People - Scan QR</title>
    <style>
        body { font-family: sans-serif; padding: 20px; text-align: center; background: #f5f5f5; }
        .container { background: white; padding: 30px; border-radius: 10px; max-width: 500px; margin: 0 auto; }
        h1 { color: #A4C71D; margin-bottom: 10px; }
        .subtitle { color: #666; margin-bottom: 30px; }
        .qr-image { margin: 20px auto; padding: 20px; background: white; display: block; border-radius: 10px; box-shadow: 0 2px 10px rgba(0,0,0,0.1); max-width: 100%; }
        .steps { text-align: left; background: #e8f5e9; padding: 15px; border-radius: 5px; margin: 20px 0; }
        .steps h3 { margin-top: 0; color: #A4C71D; }
        .steps li { margin: 8px 0; }
        .note { font-size: 12px; color: #666; margin-top: 20px; }
    </style>
    <meta http-equiv="refresh" content="10">
</head>
<body>
    <div class="container">
        <h1>📱 Scan QR Code</h1>
        <p class="subtitle">Fresh People Event Ops Bot</p>
        
        <img class="qr-image" src="${qrImage}" alt="WhatsApp QR Code">
        
        <div class="steps">
            <h3>📋 Steps:</h3>
            <ol>
                <li>Open <strong>WhatsApp</strong> on iPhone</li>
                <li>Go to <strong>Settings → Linked Devices</strong></li>
                <li>Tap <strong>"Link a Device"</strong></li>
                <li>Scan this QR code</li>
            </ol>
        </div>
        
        <p class="note">Page refreshes automatically. QR expires in ~20 seconds.</p>
    </div>
</body>
</html>
        `);
    } catch (error) {
        res.send(`<h1>Error generating QR: ${error.message}</h1>`);
    }
});

app.listen(PORT, '0.0.0.0', () => {
    console.log(`📱 QR Display server (v2) running on http://0.0.0.0:${PORT}`);
    console.log(`Access from iPhone: http://YOUR_SERVER_IP:${PORT}`);
});
