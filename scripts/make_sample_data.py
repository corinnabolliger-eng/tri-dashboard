#!/usr/bin/env python3
"""Generate realistic fake training data to preview the dashboard without a Garmin login.

    python scripts/make_sample_data.py            # writes docs/data/data.json
    python scripts/make_sample_data.py demo       # writes docs/data/data.enc.json, password "demo"
    python -m http.server -d docs 8000            # open http://localhost:8000

Delete docs/data/ before the first real sync.
"""
import datetime as dt
import math
import random
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from fetch_garmin import save  # noqa: E402

random.seed(7)
today = dt.date.today()
acts, health = [], {}
aid = 1000

def add(day, sport, typ, name, mins, dist, hr, load, speed=None, power=None, zones_bias=0.0):
    global aid
    aid += 1
    secs = mins * 60
    z = [0.18, 0.55, 0.17, 0.08, 0.02]
    z = [max(0.0, v + zones_bias * w) for v, w in zip(z, [-0.1, -0.2, 0.1, 0.15, 0.05])]
    s = sum(z)
    hour = random.choice([6, 7, 12, 17, 18])
    acts.append({
        "id": aid, "date": day.isoformat(), "start": f"{day.isoformat()}T{hour:02d}:{random.randint(0,59):02d}",
        "name": name, "type": typ, "sport": sport, "dist_m": round(dist, 1), "dur_s": secs, "elapsed_s": secs + 120,
        "avg_hr": hr, "max_hr": hr + random.randint(15, 30), "avg_speed": round(speed or dist / secs, 3),
        "avg_power": power, "np": round(power * 1.06) if power else None, "tss": None, "load": round(load, 1),
        "te_aer": round(min(5, 2 + load / 60), 1), "te_ana": round(random.uniform(0, 2), 1),
        "zones": [round(secs * v / s) for v in z] if sport != "swim" or random.random() < 0.4 else None,
        "elev": random.randint(0, 600) if sport in ("bike", "run") else 0, "cal": int(mins * 10), "pool_m": 25 if sport == "swim" else None,
    })

for back in range(400, -1, -1):
    day = today - dt.timedelta(days=back)
    wd = day.weekday()
    progress = 1 - back / 400
    block = 0.6 if (back // 7) % 4 == 0 else 1.0           # recovery week every 4th week
    vol = (0.7 + 0.5 * progress) * block
    fit = progress  # gets faster over the year
    if random.random() < 0.07:
        continue  # missed session
    if wd in (0, 3):  # swim
        mins = int(random.uniform(40, 60) * vol)
        pace100 = 125 - 12 * fit + random.uniform(-4, 4)
        add(day, "swim", "lap_swimming", "Pool swim", mins, mins * 60 / pace100 * 100, 132, mins * 0.9, zones_bias=0.2 * (wd == 3))
    if wd in (1, 5):  # bike
        long = wd == 5
        mins = int((random.uniform(140, 200) if long else random.uniform(55, 75)) * vol)
        p = int(165 + 30 * fit + random.uniform(-8, 8) + (0 if long else 18))
        add(day, "bike", "road_biking" if long else "virtual_ride", "Long ride" if long else "Zwift intervals", mins,
            mins * 60 * (8.1 + fit + random.uniform(-0.4, 0.4)), 138 if long else 149, mins * (1.0 if long else 1.35),
            power=p, zones_bias=0 if long else 0.6)
    if wd in (2, 4, 6):  # run
        long = wd == 6
        mins = int((random.uniform(75, 100) if long else random.uniform(35, 55)) * vol)
        pace = 340 - 25 * fit + random.uniform(-8, 8) - (0 if long else 10)
        add(day, "run", "running", "Long run" if long else ("Tempo run" if wd == 2 else "Easy run"), mins,
            mins * 60 / pace * 1000, 146 if wd != 2 else 158, mins * (1.2 if wd != 2 else 1.6), zones_bias=0.7 if wd == 2 else -0.1)
    if wd == 4 and random.random() < 0.5:
        add(day, "other", "strength_training", "Strength", 35, 0, 105, 20)

    if back < 120:
        base = 58 + 4 * progress
        health[day.isoformat()] = {
            "rhr": round(48 - 2 * progress + random.uniform(-2, 2) + (2 if wd == 0 else 0)),
            "hrv": round(base + 7 * math.sin(back / 5) + random.uniform(-6, 6)),
            "hrv_week": round(base + random.uniform(-2, 2)),
            "hrv_status": "BALANCED" if random.random() > 0.15 else "UNBALANCED",
            "hrv_low": round(base - 8), "hrv_high": round(base + 9),
            "sleep_h": round(random.uniform(6.2, 8.6), 2), "sleep_score": random.randint(62, 92),
            "bb_high": random.randint(60, 98), "bb_low": random.randint(5, 30), "stress": random.randint(18, 40),
            "vo2_run": round(52 + 2 * progress, 1),
        }

payload = {"generated": dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds"), "activities": acts,
           "health": health, "race_predictions": {"time5K": 1215, "time10K": 2540, "timeHalfMarathon": 5650, "timeMarathon": 12100}}
save(payload, sys.argv[1] if len(sys.argv) > 1 else None)
print(f"{len(acts)} activities, {len(health)} health days")
