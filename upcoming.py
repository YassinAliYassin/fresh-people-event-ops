import sqlite3
from datetime import date
conn = sqlite3.connect('events.db')
c = conn.cursor()
today = date.today().isoformat()
c.execute("SELECT id, event, date, time, services, staff, status FROM events WHERE date >= ? ORDER BY date, time", (today,))
rows = c.fetchall()
print(f"Events on or after {today}:")
if rows:
    for r in rows:
        print(r)
else:
    print("None")
conn.close()