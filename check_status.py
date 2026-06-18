#!/usr/bin/env python3
import sqlite3
from datetime import datetime

conn = sqlite3.connect('events.db')
cursor = conn.cursor()

# Check for upcoming events (today and future)
today = datetime.now().strftime('%Y-%m-%d')
print(f'=== UPCOMING EVENTS (from {today}) ===')
cursor.execute("SELECT id, event, date, time, location, services FROM events WHERE date >= ? ORDER BY date, time;", (today,))
upcoming = cursor.fetchall()

if upcoming:
    for event in upcoming:
        print(f'  {event[0]}: {event[1]} | {event[2]} {event[3]} | {event[4]} | Staff: {event[5]}')
else:
    print('  No upcoming events found')

# Check for date conflicts (same date, multiple events)
print(f'\n=== DATE CONFLICTS CHECK ===')
cursor.execute('''
    SELECT date, COUNT(*) as cnt, GROUP_CONCAT(id) as event_ids
    FROM events 
    WHERE date >= ?
    GROUP BY date
    HAVING cnt > 1
''', (today,))
conflicts = cursor.fetchall()

if conflicts:
    print('  WARNING: Multiple events on same date:')
    for c in conflicts:
        print(f'    {c[0]}: {c[1]} events ({c[2]})')
else:
    print('  No date conflicts found')

# Check staff shortages from notes
print(f'\n=== STAFF SHORTAGE ALERTS ===')
cursor.execute("SELECT id, event, date, services, notes FROM events WHERE notes LIKE '%WARNING%' OR notes LIKE '%shortage%'" )
shortages = cursor.fetchall()

if shortages:
    for s in shortages:
        print(f'  WARNING {s[0]}: {s[1]} ({s[2]})')
        print(f'     Services: {s[3]}')
        note_preview = s[4][:100] + '...' if len(s[4]) > 100 else s[4]
        print(f'     Note: {note_preview}')
else:
    print('  No staff shortages recorded')

# Check services status
print(f'\n=== SERVICES STATUS ===')
import subprocess
result = subprocess.run(['ps', 'aux'], capture_output=True, text=True)
processes = result.stdout

services_running = {
    'server.js': 'server.js' in processes,
    'whatsapp-api-bot': 'whatsapp-api-bot' in processes,
    'event_processor': 'event_processor' in processes
}

for service, status in services_running.items():
    print(f'  {service}: {"RUNNING" if status else "NOT RUNNING"}')

conn.close()
