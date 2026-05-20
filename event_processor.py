#!/usr/bin/env python3
"""
Fresh People Event Ops Processor
Parses booking messages and generates all outputs in one flow.
"""

import re
import random
import datetime
from typing import Dict, List, Optional

# Default staff pool
DEFAULT_STAFF = ["Mike", "Alex", "John", "Sipho", "Ben", "David", "Thabo", "Kevin"]

def generate_event_id() -> str:
    """Generate unique Event ID: FP-YYYYMMDD-XXXX"""
    date_part = datetime.datetime.now().strftime("%Y%m%d")
    random_part = ''.join(random.choices('ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789', k=4))
    return f"FP-{date_part}-{random_part}"

def parse_booking_input(text: str) -> Dict:
    """Parse the EVENT: CLIENT: ... format"""
    fields = {}
    patterns = {
        'event': r'EVENT:\s*(.+)',
        'client': r'CLIENT:\s*(.+)',
        'date': r'DATE:\s*(.+)',
        'time': r'TIME:\s*(.+)',
        'location': r'LOCATION:\s*(.+)',
        'guests': r'GUESTS:\s*(.+)',
        'staff_required': r'STAFF_REQUIRED:\s*(.+)',
        'services': r'SERVICES:\s*(.+)',
        'notes': r'NOTES:\s*(.+)'
    }
    
    for key, pattern in patterns.items():
        match = re.search(pattern, text, re.IGNORECASE)
        if match:
            fields[key] = match.group(1).strip()
        else:
            fields[key] = None
    
    return fields

def allocate_staff(num_required: int, staff_pool: List[str] = DEFAULT_STAFF) -> Dict:
    """Allocate staff and select team leader"""
    num_required = int(num_required) if num_required else 1
    num_required = min(num_required, len(staff_pool))
    
    # Shuffle but keep Mike (index 0) as likely leader
    allocated = [staff_pool[0]]  # Mike as leader
    remaining = staff_pool[1:]
    random.shuffle(remaining)
    allocated.extend(remaining[:num_required-1])
    
    return {
        'team_leader': allocated[0],
        'staff': allocated,
        'count': len(allocated)
    }

def generate_calendar_event(booking: Dict, staff_info: Dict) -> str:
    """Generate Google Calendar compatible event text"""
    event = booking
    
    # Parse date and time for calendar
    date = event.get('date', 'TBD')
    time = event.get('time', '00:00')
    
    title = f"{event.get('event', 'Event')} – {event.get('client', 'Client')} – {staff_info['count']} Staff"
    
    description = f"""Client: {event.get('client', 'TBD')}
Event Type: {event.get('event', 'TBD')}
Location: {event.get('location', 'TBD')}
Guests: {event.get('guests', 'TBD')}
Staff: {', '.join(staff_info['staff'])}
Services: {event.get('services', 'TBD')}
Notes: {event.get('notes', 'None')}"""
    
    # Fix description newlines for iCal format
    ical_description = description.replace('\n', '\\n')
    
    # Google Calendar format
    calendar_text = f"""BEGIN:VCALENDAR
VERSION:2.0
PRODID:-//Fresh People//Event Booking//EN
BEGIN:VEVENT
DTSTART:{date.replace('-', '')}T{time.replace(':', '')}00
SUMMARY:{title}
DESCRIPTION:{ical_description}
LOCATION:{event.get('location', 'TBD')}
END:VEVENT
END:VCALENDAR"""
    
    return calendar_text

def generate_deployment_message(booking: Dict, staff_info: Dict) -> str:
    """Generate WhatsApp-ready deployment message"""
    event = booking
    date = event.get('date', 'TBD')
    time = event.get('time', 'TBD')
    
    # Calculate arrival time (1 hour before)
    try:
        time_obj = datetime.datetime.strptime(time, "%H:%M")
        arrival = (time_obj - datetime.timedelta(hours=1)).strftime("%H:%M")
    except:
        arrival = "TBD"
    
    msg = f"""🚀 EVENT DEPLOYMENT
Event: {event.get('event', 'TBD')}
Client: {event.get('client', 'TBD')}
Date: {date}
Time: {time}
Location: {event.get('location', 'TBD')}
Team Leader: {staff_info['team_leader']}
Staff: {', '.join(staff_info['staff'])}
Arrival Time: {arrival}
Dress Code: All Black"""
    
    return msg

def process_booking(input_text: str) -> Dict:
    """Main processing function"""
    # Parse
    booking = parse_booking_input(input_text)
    
    # Validate
    required = ['event', 'client', 'date', 'time', 'location', 'staff_required']
    missing = [field for field in required if not booking.get(field)]
    if missing:
        return {'error': f"Missing required fields: {', '.join(missing)}"}
    
    # Process
    event_id = generate_event_id()
    staff_info = allocate_staff(booking['staff_required'])
    calendar = generate_calendar_event(booking, staff_info)
    deployment = generate_deployment_message(booking, staff_info)
    
    return {
        'event_id': event_id,
        'booking': booking,
        'staff_info': staff_info,
        'calendar_event': calendar,
        'deployment_message': deployment
    }

def format_output(result: Dict) -> str:
    """Format final output as specified"""
    if 'error' in result:
        return f"ERROR: {result['error']}"
    
    booking = result['booking']
    staff = result['staff_info']
    
    output = f"""A. EVENT ID
{result['event_id']}

B. CONFIRMED BOOKING SUMMARY
Event: {booking.get('event')}
Client: {booking.get('client')}
Date: {booking.get('date')}
Time: {booking.get('time')}
Location: {booking.get('location')}
Guests: {booking.get('guests', 'N/A')}
Services: {booking.get('services', 'N/A')}
Notes: {booking.get('notes', 'None')}

C. ASSIGNED STAFF LIST
Team Leader: {staff['team_leader']}
Staff: {', '.join(staff['staff'])}
Total: {staff['count']}

D. CALENDAR EVENT TEXT
{result['calendar_event']}

E. DEPLOYMENT MESSAGE
{result['deployment_message']}"""
    
    return output

if __name__ == "__main__":
    import sys
    
    if len(sys.argv) > 1:
        # Read from file
        with open(sys.argv[1], 'r') as f:
            input_text = f.read()
    else:
        # Read from stdin
        print("Paste booking data (Ctrl+D to process):")
        input_text = sys.stdin.read()
    
    result = process_booking(input_text)
    print(format_output(result))
