# Triathlon Training Dashboard (Garmin → GitHub)

A free, self-hosted triathlon dashboard built from your Garmin Connect data.
GitHub Actions pulls your data every night, encrypts it, and publishes the
dashboard on GitHub Pages. No server, no subscription.

**What you see**
- Form, fitness and fatigue (TSB / CTL / ATL) with 90-day, 6-month and 1-year views
- Weekly training hours (or load) stacked by swim, bike and run, against your target
- One card per sport: this week vs. target, 4-week average, pace or power trend
- Intensity distribution: time in HR zones over the last 28 days and your % easy
- Recovery: HRV with your baseline band, resting heart rate, sleep
- Race countdown, Garmin running race predictions and recent sessions

---

## Setup (about 10 minutes)

### 1. Create the repository
1. On GitHub click **New repository**. Name it, e.g., `tri-dashboard`.
2. Choose **Public**. Free GitHub Pages needs a public repo, but your data
   stays encrypted (see *Privacy* below).
3. Upload every file and folder from this zip, including the hidden
   `.github` folder. The easiest way is **Add file → Upload files**, then drag in
   the folder contents. If `.github` gets skipped, create the file
   `.github/workflows/sync.yml` by hand with **Add file → Create new file** and
   paste in its contents.

### 2. Add your secrets
Go to **Settings → Secrets and variables → Actions → New repository secret** and add:

| Name | Value |
|---|---|
| `GARMIN_EMAIL` | your Garmin Connect email |
| `GARMIN_PASSWORD` | your Garmin Connect password |
| `DASHBOARD_PASSWORD` | a **new, long** passphrase that unlocks the dashboard (not your Garmin password) |

Secrets are encrypted by GitHub and never appear in logs or the website.

### 3. Turn on GitHub Pages
**Settings → Pages → Build and deployment → Source: GitHub Actions.**

### 4. Run the first sync
**Actions** tab → *Sync Garmin & publish dashboard* → **Run workflow**.
The first run backfills about 120 days of health data and takes a few minutes.
When it's done, the run summary shows your link:
`https://<your-username>.github.io/tri-dashboard/`

From then on it runs automatically every morning at about 05:17 CET.

### 5. Personalise
Edit `docs/config.json` on GitHub (pencil icon) to set your races and your weekly
hour targets for each sport. Saving the file republishes the page.

---

## Privacy
- The data file (`docs/data/data.enc.json`) is encrypted with AES-256-GCM.
  Only someone with your `DASHBOARD_PASSWORD` can read it. The key is derived
  with 250,000 PBKDF2 rounds, so use a long passphrase.
- The code and `config.json` (race names, targets) are public. Don't put anything
  private in `config.json`.
- If you remove `DASHBOARD_PASSWORD`, the data is written **unencrypted**
  (`data.json`) and anyone with the URL can read it.
- "Remember on this device" stores the password in that browser's local storage.
  **Lock** clears it.

## Troubleshooting
- **Login failed / 401 / 403**: check the secrets first. Garmin sometimes changes
  its login, which breaks the unofficial `garminconnect` library for a few days
  until it's updated. The workflow always installs the latest version, so a later
  run usually just works again. Check the library's GitHub issues if it doesn't.
- **429 Too Many Requests**: Garmin is rate-limiting. Wait a day and don't run the
  workflow manually many times in a row.
- **"Wrong password" on the dashboard**: if you changed `DASHBOARD_PASSWORD`, the
  next sync can't read the old file and simply starts fresh, which is fine.
- **Some panels say "no data"**: not every watch records HRV, sleep score, power
  or swim heart rate.

## How the numbers are calculated
- **Load per session** = Garmin's training load. If that's missing, TSS is used;
  if both are missing, an estimate from duration.
- **Fitness (CTL)** = 42-day exponentially weighted average of daily load.
  **Fatigue (ATL)** = 7-day average. **Form (TSB)** = yesterday's CTL − ATL.
- Form guide: above +5 fresh, −10 to +5 neutral, −30 to −10 productive training,
  below −30 high fatigue.
- **Easy %** = time in HR zones 1 + 2 as Garmin defines them for you.

## Run it locally (optional)
```bash
pip install -r requirements.txt
python scripts/make_sample_data.py demo   # fake data, password "demo"
python -m http.server -d docs 8000        # open http://localhost:8000
```
Delete `docs/data/data.enc.json` again before pushing. To fetch your real data
locally, set `GARMIN_EMAIL`, `GARMIN_PASSWORD` and `DASHBOARD_PASSWORD` as
environment variables and run `python scripts/fetch_garmin.py`.

Settings you can tune with environment variables in `sync.yml`: `ACTIVITY_DAYS`
(400), `HEALTH_DAYS` (120), `MAX_HEALTH_FETCH` (150 per run).
