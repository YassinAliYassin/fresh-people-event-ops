const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } = require('@whiskeysockets/baileys');
const { Boom } = require('@hapi/boom');
const { exec } = require('child_process');
const fs = require('fs');
const path = require('path');

const EVENT_PROCESSOR = '/home/yassin/fresh-people-event-ops/event_processor.py';
const CALENDAR_DIR = '/home/yassin/fresh-people-event-ops/calendar-events';
const AUTH_FOLDER = '/home/yassin/fresh-people-event-ops/auth';
const PAIRING_PHONE = '27672961272'; // SA number with country code (27)

// Store pending bookings and staff confirmations
const pendingBookings = new Map();
const staffConfirmations = new Map();
// Staff phone numbers (configure these)
const STAFF_PHONES = {
    'Mike': '1234567890',
    'Alex': '1234567891',
    'John': '1234567892',
    'Sipho': '1234567893',
    'Ben': '1234567894',
    'David': '1234567895',
    'Thabo': '1234567896',
    'Kevin': '1234567897'
};

// Ensure dirs exist
[ CALENDAR_DIR, AUTH_FOLDER ].forEach(dir => {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
});

async function connectToWhatsApp() {
    const { state, saveCreds } = await useMultiFileAuthState(AUTH_FOLDER);
    const { version } = await fetchLatestBaileysVersion();
    
    const sock = makeWASocket({
        version,
        auth: state,
        pairingPhone: PAIRING_PHONE, // This triggers pairing code instead of QR
    });
    
    sock.ev.on('credentials.update', saveCreds);
    
    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect, qr, pairingCode } = update;
        
        // Pairing code method (no QR scanning needed!)
        if (pairingCode) {
            console.log('📱 PAIRING CODE:', pairingCode);
            console.log('📱 Type this code in WhatsApp: Settings → Linked Devices → Link a Device → Link with phone number');
            fs.writeFileSync('/tmp/whatsapp-pairing-code.txt', pairingCode);
        }
        
        if (qr) {
            console.log('📱 QR Code received (ignored, using pairing code method)');
        }
        
        if (connection === 'close') {
            const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
            console.log('Connection closed due to ', lastDisconnect?.error, ', reconnecting: ', shouldReconnect);
            if (shouldReconnect) {
                connectToWhatsApp();
            }
        } else if (connection === 'open') {
            console.log('✅ WhatsApp bot READY!');
            console.log('Logged in as:', sock.user?.id);
        }
    });
    
    sock.ev.on('messages.upsert', async (m) => {
        const msg = m.messages[0];
        if (!msg.message) return;
        if (msg.key.fromMe) return;
        
        const text = msg.message.conversation || 
                   msg.message.extendedTextMessage?.text || '';
        const from = msg.key.remoteJid;
        
        if (!text) return;
        
        console.log(`📩 Message from ${from}: ${text.substring(0, 50)}...`);
        
        // Check if this is a staff confirmation reply
        if (staffConfirmations.has(msg.key.id)) {
            const conf = staffConfirmations.get(msg.key.id);
            if (text.toUpperCase() === 'YES' || text.toUpperCase() === 'Y') {
                await handleStaffConfirmation(conf.bookingId, conf.staffName, sock, from);
                staffConfirmations.delete(msg.key.id);
            } else if (text.toUpperCase() === 'NO' || text.toUpperCase() === 'N') {
                await sock.sendMessage(from, { text: '❌ Noted. We\'ll find another staff member.' });
                staffConfirmations.delete(msg.key.id);
            }
            return;
        }
        
        // Check if this is a booking message
        if (text.includes('EVENT:') && text.includes('CLIENT:')) {
            await handleBookingMessage(text, from, sock, msg);
            return;
        }
        
        // Manual staff addition: /addstaff <bookingId> <staffName>
        if (text.startsWith('/addstaff')) {
            await handleAddStaff(text, sock, from);
            return;
        }
        
        // View booking: /booking <bookingId>
        if (text.startsWith('/booking')) {
            await handleViewBooking(text, sock, from);
            return;
        }
        
        // Help
        if (text === '/help' || text === '/start') {
            await sendHelp(sock, from);
            return;
        }
    });
    
    return sock;
}

async function handleBookingMessage(text, from, sock, msg) {
    console.log('📋 Processing booking from', from);
    
    const tempFile = '/tmp/whatsapp_booking.txt';
    fs.writeFileSync(tempFile, text);
    
    exec(`python3 ${EVENT_PROCESSOR} ${tempFile}`, async (error, stdout, stderr) => {
        if (error) {
            console.error('Processing error:', stderr);
            await sock.sendMessage(from, { text: '❌ Error processing booking. Please check format.' });
            return;
        }
        
        const result = parseEventOutput(stdout);
        
        if (result.error) {
            await sock.sendMessage(from, { text: `❌ Missing fields: ${result.error}` });
            return;
        }
        
        pendingBookings.set(result.eventId, {
            ...result,
            clientPhone: from,
            status: 'pending_staff_confirmation',
            confirmedStaff: [],
            calendarPushed: false
        });
        
        const clientMsg = `✅ *Booking Received!*

📌 Event ID: ${result.eventId}
🎉 Event: ${result.booking.event}
👤 Client: ${result.booking.client}
📅 Date: ${result.booking.date}
🕐 Time: ${result.booking.time}
📍 Location: ${result.booking.location}

_Staff allocation in progress..._`;
        
        await sock.sendMessage(from, { text: clientMsg });
        await sendStaffConfirmationRequests(result, sock);
        
        const icsPath = path.join(CALENDAR_DIR, `${result.eventId}.ics`);
        fs.writeFileSync(icsPath, result.calendarEvent);
    });
}

function parseEventOutput(output) {
    const result = {};
    
    const idMatch = output.match(/A\. EVENT ID\n([A-Z0-9-]+)/);
    if (idMatch) result.eventId = idMatch[1];
    
    const booking = {};
    const eventMatch = output.match(/Event: (.+)/);
    if (eventMatch) booking.event = eventMatch[1];
    const clientMatch = output.match(/Client: (.+)/);
    if (clientMatch) booking.client = clientMatch[1];
    const dateMatch = output.match(/Date: (.+)/);
    if (dateMatch) booking.date = dateMatch[1];
    const timeMatch = output.match(/Time: (.+)/);
    if (timeMatch) booking.time = timeMatch[1];
    const locationMatch = output.match(/Location: (.+)/);
    if (locationMatch) booking.location = locationMatch[1];
    
    result.booking = booking;
    
    const staffMatch = output.match(/Staff: (.+)/);
    if (staffMatch) {
        result.staffList = staffMatch[1].split(',').map(s => s.trim());
    }
    
    const calStart = output.indexOf('BEGIN:VCALENDAR');
    const calEnd = output.indexOf('END:VCALENDAR');
    if (calStart !== -1 && calEnd !== -1) {
        result.calendarEvent = output.substring(calStart, calEnd + 15);
    }
    
    return result;
}

async function sendStaffConfirmationRequests(bookingData, sock) {
    const staffList = bookingData.staffList || [];
    const logPath = '/home/yassin/fresh-people-event-ops/staff-confirmations.log';
    
    const logEntry = `
=== STAFF ALLOCATION ${new Date().toISOString()} ===
Event ID: ${bookingData.eventId}
Event: ${bookingData.booking.event}
Date: ${bookingData.booking.date}
Time: ${bookingData.booking.time}
Location: ${bookingData.booking.location}
Staff: ${staffList.join(', ')}
Team Leader: ${staffList[0] || 'None'}
================================
`;
    
    fs.appendFileSync(logPath, logEntry);
    console.log(`Staff allocation logged to ${logPath}`);
    
    // TODO: Add staff phone numbers later to enable WhatsApp confirmations
    // Current numbers in STAFF_PHONES are placeholders
}

async function handleStaffConfirmation(bookingId, staffName, sock, from) {
    const booking = pendingBookings.get(bookingId);
    if (!booking) {
        await sock.sendMessage(from, { text: '❌ Booking not found.' });
        return;
    }
    
    booking.confirmedStaff.push(staffName);
    await sock.sendMessage(from, { text: `✅ Thanks ${staffName}! You're confirmed for ${booking.booking.event}.` });
    
    await updateCalendarWithStaff(bookingId);
    
    const clientPhone = booking.clientPhone;
    await sock.sendMessage(clientPhone, { 
        text: `✅ ${staffName} confirmed for ${booking.booking.event}!`
    });
}

async function updateCalendarWithStaff(bookingId) {
    const booking = pendingBookings.get(bookingId);
    if (!booking) return;
    
    const confirmedStaff = booking.confirmedStaff.join(', ');
    const icsPath = path.join(CALENDAR_DIR, `${bookingId}.ics`);
    
    let ics = booking.calendarEvent || '';
    if (ics) {
        ics = ics.replace(
            /DESCRIPTION:.*?LOCATION/s,
            `DESCRIPTION:Confirmed Staff: ${confirmedStaff}\\nClient: ${booking.booking.client}\\nLOCATION`
        );
        fs.writeFileSync(icsPath, ics);
    }
    
    console.log(`📅 Calendar updated for ${bookingId} with staff: ${confirmedStaff}`);
}

async function handleAddStaff(text, sock, from) {
    const parts = text.split(' ');
    if (parts.length < 3) {
        await sock.sendMessage(from, { text: '❌ Usage: /addstaff <bookingId> <staffName>' });
        return;
    }
    
    const bookingId = parts[1];
    const staffName = parts.slice(2).join(' ');
    
    const booking = pendingBookings.get(bookingId);
    if (!booking) {
        await sock.sendMessage(from, { text: '❌ Booking ID not found.' });
        return;
    }
    
    booking.confirmedStaff.push(staffName);
    await updateCalendarWithStaff(bookingId);
    await sock.sendMessage(from, { text: `✅ ${staffName} added to booking ${bookingId}` });
}

async function handleViewBooking(text, sock, from) {
    const parts = text.split(' ');
    if (parts.length < 2) {
        await sock.sendMessage(from, { text: '❌ Usage: /booking <bookingId>' });
        return;
    }
    
    const bookingId = parts[1];
    const booking = pendingBookings.get(bookingId);
    
    if (!booking) {
        await sock.sendMessage(from, { text: '❌ Booking not found.' });
        return;
    }
    
    const info = `📋 *Booking ${bookingId}*

Event: ${booking.booking.event}
Client: ${booking.booking.client}
Date: ${booking.booking.date}
Time: ${booking.booking.time}
Location: ${booking.booking.location}

✅ Confirmed Staff:
${booking.confirmedStaff.map(s => `• ${s}`).join('\n')}

Status: ${booking.status}`;
    
    await sock.sendMessage(from, { text: info });
}

async function sendHelp(sock, from) {
    const help = `🚀 *Fresh People Event Ops Bot*

*Commands:*
/help - Show this help
/booking <id> - View booking details
/addstaff <id> <name> - Manually add staff

*To book, send message in format:*
EVENT: Corporate Gala
CLIENT: Sarah M
DATE: 2026-06-15
TIME: 18:00
LOCATION: JHB Centre
GUESTS: 200
STAFF_REQUIRED: 5
SERVICES: Waiters
NOTES: VIP setup

_Staff will receive confirmation requests automatically._`;
    
    await sock.sendMessage(from, { text: help });
}

// Start the bot
connectToWhatsApp().catch(err => {
    console.error('Failed to start WhatsApp bot:', err);
});
