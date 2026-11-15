#!/usr/bin/env python3
"""
Fetch triathlon-relevant data from Garmin Connect and write it for the dashboard.

Runs nightly in GitHub Actions (see .github/workflows/sync.yml) but also works
locally:

    export GARMIN_EMAIL="you@example.com"
    export GARMIN_PASSWORD="..."
    export DASHBOARD_PASSWORD="a long passphrase"   # optional but recommended
    python scripts/fetch_garmin.py

Output (in docs/data/):
  - data.enc.json  when DASHBOARD_PASSWORD is set (AES-256-GCM, decrypted in the browser)
  - data.json      otherwise (plain text: anyone who can see your site can read it!)

The script is incremental: it re-reads the previous data file, keeps what it has,
refreshes the last few days and backfills missing days.
"""
from __future__ import annotations

import base64
import datetime as dt
import gzip
import json
import os
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DATA_DIR = ROOT / "docs" / "data"
ENC_FILE = DATA_DIR / "data.enc.json"
PLAIN_FILE = DATA_DIR / "data.json"

ACTIVITY_DAYS = int(os.getenv("ACTIVITY_DAYS", "400"))   # activity history to keep
HEALTH_DAYS = int(os.getenv("HEALTH_DAYS", "120"))       # daily health history to keep
REFRESH_DAYS = 3                                          # always re-fetch the most recent days
MAX_HEALTH_FETCH = int(os.getenv("MAX_HEALTH_FETCH", "150"))  # cap per run (be nice to Garmin)
PBKDF2_ITER = 250_000


# --------------------------------------------------------------------------- helpers
def log(msg: str) -> None:
    print(msg, flush=True)


def safe(fn, *args, default=None, **kwargs):
    """Call a Garmin API method, never crash the whole run on one failed call."""
    try:
        return fn(*args, **kwargs)
    except Exception as exc:  # noqa: BLE001
        log(f"  ! {getattr(fn, '__name__', fn)}{args}: {type(exc).__name__}: {str(exc)[:160]}")
        return default


def dig(obj, *path, default=None):
    for key in path:
        if obj is None:
            return default
        if isinstance(key, int):
            if not isinstance(obj, list) or len(obj) <= key:
                return default
            obj = obj[key]
        else:
            if not isinstance(obj, dict):
                return default
            obj = obj.get(key)
    return default if obj is None else obj


def num(x, nd=None):
    try:
        v = float(x)
    except (TypeError, ValueError):
        return None
    if v != v:  # NaN
        return None
    return round(v, nd) if nd is not None else v


# --------------------------------------------------------------------------- encryption
def encrypt(payload: dict, password: str) -> dict:
    from cryptography.hazmat.primitives import hashes
    from cryptography.hazmat.primitives.ciphers.aead import AESGCM
    from cryptography.hazmat.primitives.kdf.pbkdf2 import PBKDF2HMAC

    raw = gzip.compress(json.dumps(payload, separators=(",", ":")).encode())
    salt, iv = os.urandom(16), os.urandom(12)
    key = PBKDF2HMAC(algorithm=hashes.SHA256(), length=32, salt=salt, iterations=PBKDF2_ITER).derive(
        password.encode()
    )
    ct = AESGCM(key).encrypt(iv, raw, None)  # ciphertext || tag, same layout as WebCrypto
    b64 = lambda b: base64.b64encode(b).decode()
    return {"v": 1, "kdf": "PBKDF2-SHA256", "iter": PBKDF2_ITER, "salt": b64(salt), "iv": b64(iv),
            "gzip": True, "ct": b64(ct)}


def decrypt(env: dict, password: str) -> dict:
    from cryptography.hazmat.primitives import hashes
    from cryptography.hazmat.primitives.ciphers.aead import AESGCM
    from cryptography.hazmat.primitives.kdf.pbkdf2 import PBKDF2HMAC

    d = lambda s: base64.b64decode(s)
    key = PBKDF2HMAC(algorithm=hashes.SHA256(), length=32, salt=d(env["salt"]),
                     iterations=int(env["iter"])).derive(password.encode())
    raw = AESGCM(key).decrypt(d(env["iv"]), d(env["ct"]), None)
    if env.get("gzip"):
        raw = gzip.decompress(raw)
    return json.loads(raw)


def load_previous(password: str | None) -> dict:
    try:
        if password and ENC_FILE.exists():
            return decrypt(json.loads(ENC_FILE.read_text()), password)
        if PLAIN_FILE.exists():
            return json.loads(PLAIN_FILE.read_text())
    except Exception as exc:  # noqa: BLE001
        log(f"Could not read previous data ({exc}); starting fresh.")
    return {}


def save(payload: dict, password: str | None) -> None:
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    if password:
        ENC_FILE.write_text(json.dumps(encrypt(payload, password)))
        if PLAIN_FILE.exists():
            PLAIN_FILE.unlink()  # never leave a readable copy behind
        log(f"Wrote encrypted {ENC_FILE.relative_to(ROOT)}")
    else:
        PLAIN_FILE.write_text(json.dumps(payload, separators=(",", ":")))
        log(f"Wrote UNENCRYPTED {PLAIN_FILE.relative_to(ROOT)} (set DASHBOARD_PASSWORD to encrypt)")


# --------------------------------------------------------------------------- mapping
def sport_of(type_key: str) -> str:
    t = (type_key or "").lower()
    if "swim" in t:
        return "swim"
    if any(k in t for k in ("cycl", "bik", "ride", "spinning")):
        return "bike"
    if "run" in t:
        return "run"
    if any(k in t for k in ("strength", "weight", "hiit")):
        return "strength"
    if t in ("multi_sport", "triathlon", "duathlon") or "multisport" in t:
        return "multi"
    return "other"


def map_activity(a: dict) -> dict:
    type_key = dig(a, "activityType", "typeKey", default="")
    start = str(a.get("startTimeLocal") or "")
    zones = [num(a.get(f"hrTimeInZone_{i}"), 0) or 0 for i in range(1, 6)]
    return {
        "id": a.get("activityId"),
        "date": start[:10],
        "start": start[:16].replace(" ", "T"),
        "name": a.get("activityName") or type_key,
        "type": type_key,
        "sport": sport_of(type_key),
        "dist_m": num(a.get("distance"), 1),
        "dur_s": num(a.get("movingDuration") or a.get("duration"), 0),
        "elapsed_s": num(a.get("duration"), 0),
        "avg_hr": num(a.get("averageHR"), 0),
        "max_hr": num(a.get("maxHR"), 0),
        "avg_speed": num(a.get("averageSpeed"), 3),
        "avg_power": num(a.get("avgPower"), 0),
        "np": num(a.get("normPower"), 0),
        "tss": num(a.get("trainingStressScore"), 1),
        "load": num(a.get("activityTrainingLoad"), 1),
        "te_aer": num(a.get("aerobicTrainingEffect"), 1),
        "te_ana": num(a.get("anaerobicTrainingEffect"), 1),
        "zones": zones if any(zones) else None,
        "elev": num(a.get("elevationGain"), 0),
        "cal": num(a.get("calories"), 0),
        "pool_m": num(a.get("poolLength"), 0),
        "sets": num(a.get("activeSets") or a.get("totalSets"), 0),
        "reps": num(a.get("totalReps"), 0),
    }


def fetch_health_day(g, day: str) -> dict:
    out: dict = {}
    stats = safe(g.get_stats, day) or {}
    out["rhr"] = num(stats.get("restingHeartRate"))
    out["bb_high"] = num(stats.get("bodyBatteryHighestValue"))
    out["bb_low"] = num(stats.get("bodyBatteryLowestValue"))
    out["stress"] = num(stats.get("averageStressLevel"))
    out["steps"] = num(stats.get("totalSteps"))

    hrv = safe(g.get_hrv_data, day) or {}
    out["hrv"] = num(dig(hrv, "hrvSummary", "lastNightAvg"))
    out["hrv_week"] = num(dig(hrv, "hrvSummary", "weeklyAvg"))
    out["hrv_status"] = dig(hrv, "hrvSummary", "status")
    out["hrv_low"] = num(dig(hrv, "hrvSummary", "baseline", "balancedLow"))
    out["hrv_high"] = num(dig(hrv, "hrvSummary", "baseline", "balancedUpper"))

    sleep = safe(g.get_sleep_data, day) or {}
    secs = num(dig(sleep, "dailySleepDTO", "sleepTimeSeconds"))
    out["sleep_h"] = round(secs / 3600, 2) if secs else None
    out["sleep_score"] = num(dig(sleep, "dailySleepDTO", "sleepScores", "overall", "value"))

    if hasattr(g, "get_training_readiness"):
        tr = safe(g.get_training_readiness, day)
        if isinstance(tr, list):
            tr = tr[0] if tr else {}
        out["readiness"] = num(dig(tr or {}, "score"))

    mm = safe(g.get_max_metrics, day)
    if isinstance(mm, list):
        mm = mm[0] if mm else {}
    out["vo2_run"] = num(dig(mm or {}, "generic", "vo2MaxPreciseValue") or dig(mm or {}, "generic", "vo2MaxValue"))
    out["vo2_bike"] = num(dig(mm or {}, "cycling", "vo2MaxPreciseValue") or dig(mm or {}, "cycling", "vo2MaxValue"))

    return {k: v for k, v in out.items() if v is not None}


# --------------------------------------------------------------------------- main
def main() -> int:
    email = os.getenv("GARMIN_EMAIL")
    password = os.getenv("GARMIN_PASSWORD")
    dash_pw = os.getenv("DASHBOARD_PASSWORD") or None
    if not email or not password:
        log("GARMIN_EMAIL and GARMIN_PASSWORD must be set (GitHub: Settings > Secrets > Actions).")
        return 1

    try:
        from garminconnect import Garmin
    except ImportError:
        log("Missing dependency: pip install -r requirements.txt")
        return 1

    log("Logging in to Garmin Connect ...")
    g = Garmin(email, password)
    try:
        g.login()
    except Exception as exc:  # noqa: BLE001
        log(f"Login failed: {type(exc).__name__}: {exc}")
        log("Tip: check the credentials, then update garminconnect (pip install -U garminconnect).")
        return 2
    log("Logged in.")

    prev = load_previous(dash_pw)
    today = dt.date.today()

    # ---- activities: one paged call covers the whole window
    start = (today - dt.timedelta(days=ACTIVITY_DAYS)).isoformat()
    log(f"Fetching activities since {start} ...")
    raw = safe(g.get_activities_by_date, start, today.isoformat())
    if raw is None:
        log("Activity fetch failed, keeping previous activities.")
        activities = prev.get("activities", [])
    else:
        by_id = {a["id"]: a for a in prev.get("activities", []) if a.get("id")}
        for a in raw:
            m = map_activity(a)
            if m["id"]:
                by_id[m["id"]] = m
        activities = [a for a in by_id.values() if a.get("date", "") >= start]
        log(f"  {len(raw)} activities from Garmin, {len(activities)} kept.")
    activities.sort(key=lambda a: a.get("start") or "")

    # ---- daily health: refresh recent days, backfill the rest
    health: dict = {d: v for d, v in prev.get("health", {}).items()
                    if d >= (today - dt.timedelta(days=HEALTH_DAYS)).isoformat()}
    wanted = [(today - dt.timedelta(days=i)).isoformat() for i in range(HEALTH_DAYS)]
    todo = [d for i, d in enumerate(wanted) if i < REFRESH_DAYS or d not in health][:MAX_HEALTH_FETCH]
    log(f"Fetching daily health for {len(todo)} day(s) ...")
    for i, day in enumerate(todo, 1):
        rec = fetch_health_day(g, day)
        if rec:
            health[day] = rec
        if i % 20 == 0:
            log(f"  {i}/{len(todo)}")
        time.sleep(0.25)

    # ---- race predictions (running), optional
    preds = safe(g.get_race_predictions) if hasattr(g, "get_race_predictions") else None
    if isinstance(preds, list):
        preds = preds[0] if preds else None
    race_pred = None
    if isinstance(preds, dict):
        race_pred = {k: preds.get(k) for k in ("time5K", "time10K", "timeHalfMarathon", "timeMarathon")
                     if preds.get(k)}

    payload = {
        "generated": dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds"),
        "activities": activities,
        "health": dict(sorted(health.items())),
        "race_predictions": race_pred or prev.get("race_predictions"),
    }
    save(payload, dash_pw)
    log("Done.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
