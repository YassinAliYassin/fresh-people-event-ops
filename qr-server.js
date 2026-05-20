const express = require('express');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = 3001;

// Serve QR code page
app.get('/', (req, res) => {
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
    <meta http-equiv="refresh" content="5">
</head>
<body>
    <div class="container">
        <h1>🚀 Fresh People WhatsApp Bot</h1>
        <div class="status">⏳ Waiting for QR code generation...</div>
        <p>This page auto-refreshes every 5 seconds.</p>
    </div>
</body>
</html>
        `);
    }
    
    const qrData = fs.readFileSync(qrPath, 'utf8');
    
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
        #qrcode { margin: 20px auto; padding: 20px; background: white; display: inline-block; border-radius: 10px; box-shadow: 0 2px 10px rgba(0,0,0,0.1); }
        .steps { text-align: left; background: #e8f5e9; padding: 15px; border-radius: 5px; margin: 20px 0; }
        .steps h3 { margin-top: 0; color: #A4C71D; }
        .steps li { margin: 8px 0; }
        .note { font-size: 12px; color: #666; margin-top: 20px; }
    </style>
    <script src="https://cdn.jsdelivr.net/npm/qrcode@1.5.3/build/qrcode.min.js"></script>
</head>
<body>
    <div class="container">
        <h1>📱 Scan QR Code</h1>
        <p class="subtitle">Fresh People Event Ops Bot</p>
        
        <div id="qrcode"></div>
        
        <div class="steps">
            <h3>📋 Steps:</h3>
            <ol>
                <li>Open <strong>WhatsApp</strong> on iPhone</li>
                <li>Go to <strong>Settings → Linked Devices</strong></li>
                <li>Tap <strong>"Link a Device"</strong></li>
                <li>Scan this QR code</li>
            </ol>
        </div>
        
        <p class="note">QR code refreshes automatically when new one generated.</p>
    </div>
    
    <script>
        const qrData = ${JSON.stringify(qrData)};
        QRCode.toCanvas(document.getElementById('qrcode'), qrData, {
            width: 250,
            margin: 2
        }, function (error) {
            if (error) console.error(error);
        });
    </script>
</body>
</html>
    `);
});

app.listen(PORT, '0.0.0.0', () => {
    console.log(`📱 QR Display server running on http://0.0.0.0:${PORT}`);
    console.log(`Access from iPhone: http://YOUR_SERVER_IP:${PORT}`);
});
