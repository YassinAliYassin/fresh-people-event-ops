# Fresh People Event Operations

Automated event booking and operations management system for Fresh People.

## Features
• Event booking parsing (EVENT, CLIENT, DATE, TIME, LOCATION, etc.)
• Automatic staff allocation (9 default staff members)
• Google Calendar compatible event generation
• Team deployment message generation
• Unique Event ID generation

## Usage
Send a message in the following format:

```
EVENT: Corporate Gala
CLIENT: John Doe
DATE: 2026-06-15
TIME: 18:00
LOCATION: Johannesburg Convention Centre
GUESTS: 200
STAFF_REQUIRED: 5
SERVICES: Waiters, Baristas
NOTES: VIP Section needed
```

The system processes everything in one flow and returns:
A. Event ID
B. Booking Summary
C. Assigned Staff List
D. Calendar Event Text
E. Deployment Message

## Default Staff Pool
Mike, Alex, John, Sipho, Ben, David, Thabo, Kevin

## Repository
https://github.com/YassinAliYassin/fresh-people-event-ops
