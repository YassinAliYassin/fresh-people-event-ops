#!/usr/bin/env python3
import sqlite3
import json
from collections import defaultdict

conn = sqlite3.connect('events.db')
cursor = conn.cursor()

# Get all events with their dates, times, and staff
cursor.execute('SELECT id, event, date, time, location, staff, status FROM events WHERE status != "cancelled" OR status IS NULL;')
events = cursor.fetchall()

print('=== BOOKING CONFLICT ANALYSIS ===\n')

# Group events by date
events_by_date = defaultdict(list)
for event in events:
    event_id, event_name, date, time, location, staff_json, status = event
    try:
        staff_list = json.loads(staff_json) if staff_json else []
    except:
        staff_list = []
    
    events_by_date[date].append({
        'id': event_id,
        'name': event_name,
        'time': time,
        'location': location,
        'staff': staff_list,
        'status': status
    })

# Check for conflicts
conflicts_found = False
for date, day_events in events_by_date.items():
    if len(day_events) > 1:
        print(f'Date: {date}')
        print(f'  Events scheduled: {len(day_events)}')
        
        # Check staff overlaps
        all_staff = []
        for evt in day_events:
            all_staff.extend(evt['staff'])
        
        # Find duplicates (staff double-booked)
        staff_counts = defaultdict(int)
        for staff in all_staff:
            staff_counts[staff] += 1
        
        double_booked = {k: v for k, v in staff_counts.items() if v > 1}
        
        if double_booked:
            conflicts_found = True
            print(f'  STAFF CONFLICTS: {double_booked}')
            for evt in day_events:
                print(f'    - {evt["id"]}: {evt["name"]} @ {evt["time"]} | Staff: {evt["staff"]}')
        else:
            print(f'  No staff conflicts')
        print()

if not conflicts_found:
    print('No booking conflicts detected')

# Check for events with staff shortages
print('\n=== STAFF ALLOCATION CHECK ===')
cursor.execute('SELECT id, event, staff, status, notes FROM events WHERE notes LIKE "%shortage%" OR notes LIKE "%WARNING%" OR status IS NULL;')
problem_events = cursor.fetchall()

if problem_events:
    print(f'Events with staffing issues: {len(problem_events)}')
    for evt in problem_events:
        print(f'  - {evt[0]}: {evt[1]} | Status: {evt[2]} | Notes: {evt[3][:50] if evt[3] else "None"}')
else:
    print('No staffing issues detected')

conn.close()
