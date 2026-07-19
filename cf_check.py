#!/usr/bin/env python3
import urllib.request, json, ssl, re

TOKEN = "cfat..."
ZONE_ID = "5e3c1a3b5e4cd3b67545feeb1136fb62"
DOMAIN = "fresh-people.co.za"

headers = {
    "Authorization": f"Bearer {TOKEN}",
    "Content-Type": "application/json"
}

ctx = ssl.create_default_context()

def api_get(url):
    req = urllib.request.Request(url, headers=headers)
    resp = urllib.request.urlopen(req, context=ctx)
    return json.loads(resp.read())

def api_post(url, data):
    body = json.dumps(data).encode()
    req = urllib.request.Request(url, data=body, headers=headers, method="POST")
    resp = urllib.request.urlopen(req, context=ctx)
    return json.loads(resp.read())

# Step 1: Check zone status
print("=== Zone Status ===")
status = None
try:
    zone = api_get(f"https://api.cloudflare.com/client/v4/zones/{ZONE_ID}")
    print(json.dumps(zone, indent=2))
    status = zone.get("result", {}).get("status", "unknown")
    print(f"\nZone status: {status}")
except Exception as e:
    print(f"Error checking zone by ID: {e}")
    print("\n=== Listing all zones ===")
    try:
        zones = api_get(f"https://api.cloudflare.com/client/v4/zones?name={DOMAIN}")
        print(json.dumps(zones, indent=2))
        if zones.get("result"):
            status = zones["result"][0].get("status", "unknown")
            zone_id = zones["result"][0].get("id", "unknown")
            print(f"\nFound zone: {zone_id} with status: {status}")
        else:
            print("No zones found for this domain.")
    except Exception as e2:
        print(f"Error listing zones: {e2}")

# Step 2: If active, purge cache
if status == "active":
    print("\n=== Purging Cache ===")
    try:
        result = api_post(
            f"https://api.cloudflare.com/client/v4/zones/{ZONE_ID}/purge_cache",
            {"purge_everything": True}
        )
        print(json.dumps(result, indent=2))
        print("Cache purge completed successfully.")
    except Exception as e:
        print(f"Error purging cache: {e}")
else:
    print(f"\nSkipping cache purge (status: {status})")

# Step 3: Check site keywords
print("\n=== Site Keywords Check ===")
try:
    req = urllib.request.Request(f"https://{DOMAIN}", headers={"User-Agent": "Mozilla/5.0"})
    resp = urllib.request.urlopen(req, context=ctx, timeout=15)
    html = resp.read().decode("utf-8", errors="replace")
    
    kw_match = re.search(r'<meta[^>]*name=["\']keywords["\'][^>]*content=["\']([^"\']*)["\']', html, re.IGNORECASE)
    if not kw_match:
        kw_match = re.search(r'<meta[^>]*content=["\']([^"\']*)["\'][^>]*name=["\']keywords["\']', html, re.IGNORECASE)
    
    if kw_match:
        keywords = kw_match.group(1)
        print(f"Keywords found: {keywords}")
        unwanted = ["models", "makeup", "security", "DJs", "DJ"]
        found_unwanted = [w for w in unwanted if w.lower() in keywords.lower()]
        if found_unwanted:
            print(f"UNWANTED keywords detected: {found_unwanted}")
        else:
            print("No unwanted keywords found.")
    else:
        print("No meta keywords tag found on the page.")
except Exception as e:
    print(f"Error fetching site: {e}")
