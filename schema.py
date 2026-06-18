import sqlite3
conn = sqlite3.connect('events.db')
c = conn.cursor()
# Get table names
c.execute("SELECT name FROM sqlite_master WHERE type='table';")
tables = c.fetchall()
print("Tables:", tables)
for table in tables:
    tname = table[0]
    print(f"\nSchema for {tname}:")
    c.execute(f"PRAGMA table_info({tname});")
    cols = c.fetchall()
    for col in cols:
        print(col)
conn.close()