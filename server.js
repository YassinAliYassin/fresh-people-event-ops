const express = require('express');
const { body, validationResult } = require('express-validator');
const { exec } = require('child_process');
const path = require('path');
const fs = require('fs');

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const PORT = process.env.PORT || 3000;
const EVENT_PROCESSOR = path.join(__dirname, 'event_processor.py');

// Process WhatsApp booking message
app.post('/process-booking', [
    body('message').notEmpty().withMessage('Message is required')
], (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
        return res.status(400).json({ errors: errors.array() });
    }

    const { message } = req.body;
    const tempFile = '/tmp/fresh_people_booking.txt';
    
    fs.writeFileSync(tempFile, message);
    
    exec(`python3 ${EVENT_PROCESSOR} ${tempFile}`, (error, stdout, stderr) => {
        if (error) {
            return res.status(500).json({ 
                error: 'Processing failed', 
                details: stderr 
            });
        }
        
        res.json({ 
            success: true,
            result: stdout 
        });
    });
});

// Web form for manual paste
app.get('/', (req, res) => {
    res.send(`
<!DOCTYPE html>
<html>
<head>
    <title>Fresh People - Event Ops</title>
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <style>
        * { box-sizing: border-box; margin: 0; padding: 0; }
        body { 
            font-family: 'Inter', -apple-system, BlinkMacSystemFont, sans-serif; 
            padding: 20px; 
            background: #FBFBF9; 
            color: #0A0A0A;
            max-width: 800px;
            margin: 0 auto;
        }
        h1 { 
            color: #A4C71D; 
            margin-bottom: 10px;
            font-size: 2rem;
        }
        .subtitle { 
            color: #666; 
            margin-bottom: 30px;
            font-size: 1rem;
        }
        textarea { 
            width: 100%; 
            height: 250px; 
            margin: 15px 0; 
            padding: 15px; 
            border: 2px solid #ddd;
            border-radius: 8px;
            font-size: 14px;
            font-family: 'Courier New', monospace;
            resize: vertical;
        }
        textarea:focus {
            outline: none;
            border-color: #A4C71D;
        }
        button { 
            background: #A4C71D; 
            color: white; 
            padding: 12px 30px; 
            border: none; 
            cursor: pointer; 
            font-size: 16px;
            border-radius: 8px;
            font-weight: 600;
            transition: all 0.3s;
        }
        button:hover { 
            background: #8FB018;
            transform: translateY(-2px);
        }
        h3 { 
            margin-top: 30px; 
            color: #0A0A0A;
        }
        pre { 
            background: #0A0A0A; 
            color: #FBFBF9; 
            padding: 20px; 
            border-radius: 8px;
            overflow-x: auto; 
            white-space: pre-wrap; 
            margin-top: 15px;
            font-size: 13px;
            line-height: 1.6;
        }
        .info {
            background: #fff;
            padding: 15px;
            border-radius: 8px;
            margin-bottom: 20px;
            border-left: 4px solid #A4C71D;
        }
    </style>
</head>
<body>
    <h1>🚀 Fresh People Event Ops</h1>
    <p class="subtitle">WhatsApp Booking Processor - Standalone System</p>
    
    <div class="info">
        <strong>📋 Format:</strong><br>
        EVENT: [event name]<br>
        CLIENT: [client name]<br>
        DATE: [YYYY-MM-DD]<br>
        TIME: [HH:MM]<br>
        LOCATION: [venue]<br>
        GUESTS: [number]<br>
        STAFF_REQUIRED: [number]<br>
        SERVICES: [list]<br>
        NOTES: [details]
    </div>
    
    <textarea id="message" placeholder="Paste WhatsApp booking message here..."></textarea>
    <br>
    <button onclick="processMessage()">🚀 Process Booking</button>
    
    <h3>📊 Result:</h3>
    <pre id="result">Waiting for input...</pre>
    
    <script>
        function processMessage() {
            const msg = document.getElementById('message').value;
            document.getElementById('result').textContent = 'Processing...';
            
            fetch('/process-booking', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ message: msg })
            })
            .then(r => r.json())
            .then(data => {
                document.getElementById('result').textContent = data.result || JSON.stringify(data, null, 2);
            })
            .catch(err => {
                document.getElementById('result').textContent = 'Error: ' + err;
            });
        }
    </script>
</body>
</html>
    `);
});

// Health check
app.get('/health', (req, res) => {
    res.json({ 
        status: 'ok', 
        service: 'Fresh People Event Ops',
        version: '1.0.0',
        standalone: true
    });
});

app.listen(PORT, () => {
    console.log(`🚀 Fresh People Event Ops running on port ${PORT}`);
    console.log(`📱 Web interface: http://localhost:${PORT}`);
    console.log(`⚙️  API endpoint: http://localhost:${PORT}/process-booking`);
});
