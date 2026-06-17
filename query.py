import sqlite3
conn = sqlite3.connect('events.db')
c = conn.cursor()
c.execute('SELECT id, event, date, time, client, status FROM events WHERE date >= date("now") ORDER BY date, time')
rows = c.fetchall()
print('Upcoming events:')
for r in rows:
    print(r)
conn.close()