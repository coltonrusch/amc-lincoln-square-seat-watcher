# AMC IMAX 70mm Seat Watcher

Watches AMC Lincoln Square 13 (NYC) for good seats at IMAX 70mm showings and emails a notification the moment seats open up.

It uses two complementary **GitHub Actions** scans:

- **Broad scan:** checks every Odyssey date when dispatched every 30 minutes by the external scheduler.
- **Urgent scan:** checks only showtimes inside the next 48 hours. The desired cadence is every 10 minutes when a showing is 12–48 hours away, every 5 minutes at 4–12 hours, and every 2 minutes inside four hours.

When a showtime has a seat in the target zone, each recipient gets an email with the countdown, seat count, seat numbers, and a direct booking link.

AMC navigation is retried up to three times using a fresh browser session. Date pages and seat maps are scanned in conservative batches of three to keep a full scan comfortably below the scheduling interval without sending an excessive burst of requests. Email delivery remains sequential. Every run logs how many target-zone and non-target seats it observed, including aggregate row-by-row counts, providing a continuous check that seat parsing still works.

If an individual seat map still fails after all retries, the watcher continues processing every other showtime and sends any qualifying alerts it can. The workflow is marked failed only after that processing finishes, so a partial AMC outage cannot suppress unrelated seat alerts.

---

## What it's currently watching

- **Theater:** AMC Lincoln Square 13
- **Format:** IMAX 70mm
- **Movies:** The Odyssey
- **Seats:** rows F/G/H/J/K/L/M, columns 9–39 (good immersive through rear-center options)
- **Showtimes:** any time
- **Window:** every AMC-exposed date from July 16–August 31, 2026, plus the rolling next 14 days
- **Threshold:** email sent when a showtime has **1+ seat** in the zone
- **Recipients:** set in the repo's `NOTIFY_EMAIL` secret (comma-separated)

### Scan modes

| Mode | Scope | Workflow |
| --- | --- | --- |
| Broad | All configured Odyssey dates | `check-seats.yml` |
| Urgent | Unstarted showtimes within 48 hours | `check-urgent-seats.yml` |

The urgent workflow can be dispatched every two minutes without scanning every seat map every time. The script uses the clock to select the showtimes whose 2-, 5-, or 10-minute tier is due. It stops checking a showtime once its printed start time passes. All time calculations use `America/New_York`, regardless of the GitHub runner's time zone.

---

## How to change what's being watched

All tweakable settings live at the top of [`amc-node.js`](./amc-node.js). Edit the file, commit, push — the next run uses the new values.

| Want to change… | Edit this |
| --- | --- |
| Which movies to watch | `MOVIES` array (lowercase, one entry per title; include punctuation variants when needed) |
| Which rows count as good | `TARGET_ROWS` |
| Which columns count as good | `TARGET_COL_MIN`, `TARGET_COL_MAX` |
| Earliest showtime | `MIN_SHOWTIME_MINUTES` (e.g., `13 * 60` = 1:00pm) |
| Minimum seats to trigger email | `MIN_SEATS_FOR_EMAIL` |
| How many days ahead to scan | `MAX_DATES` |
| Advance-sale date ranges | `ADVANCE_DATE_WINDOWS` |
| Which theater | `THEATER_URL` (Lincoln Square for now; any AMC showtimes URL will work) |

### Quick edit workflow

1. Open `amc-node.js` in GitHub's web editor (press `.` on the repo page, or click the file → pencil icon).
2. Change the value.
3. Commit directly to `main`. That push triggers a run within ~30 seconds — you can watch it in the **Actions** tab.

---

## Managing email recipients

Recipients are stored as a GitHub repo secret called `NOTIFY_EMAIL` (comma-separated, no spaces needed).

**To add/change recipients**, from any terminal with `gh` installed and logged in:

```bash
gh secret set NOTIFY_EMAIL --repo coltonrusch/amc-lincoln-square-seat-watcher --body 'you@example.com,friend@example.com'
```

Or do it in the UI: **Settings → Secrets and variables → Actions → `NOTIFY_EMAIL` → Update**.

---

## How to trigger a run manually (test)

**Quick broad test with a widened seat zone** (likely to find and email seats, useful for confirming the pipeline works):

```bash
gh workflow run check-seats.yml --repo coltonrusch/amc-lincoln-square-seat-watcher -f test_mode=true
```

**Normal run** (narrow seat zone — may find nothing):

```bash
gh workflow run check-seats.yml --repo coltonrusch/amc-lincoln-square-seat-watcher
```

**Urgent run checking every showtime inside 48 hours immediately:**

```bash
gh workflow run check-urgent-seats.yml --repo coltonrusch/amc-lincoln-square-seat-watcher -f force_all_due=true
```

Or use the GitHub UI: **Actions → Broad AMC Seat Scan** or **Urgent AMC Seat Scan → Run workflow**.

---

## External scheduling

GitHub's built-in scheduler is best-effort, so cron-job.org is the sole scheduler for both scan workflows. The final-four-hour tier needs the urgent workflow dispatched every two minutes.

Configure the broad external job every 30 minutes:

```text
POST https://api.github.com/repos/coltonrusch/amc-lincoln-square-seat-watcher/actions/workflows/check-seats.yml/dispatches
```

Configure the urgent external job every two minutes:

```text
POST https://api.github.com/repos/coltonrusch/amc-lincoln-square-seat-watcher/actions/workflows/check-urgent-seats.yml/dispatches
```

Request body:

```json
{"ref":"main"}
```

Headers:

```text
Accept: application/vnd.github+json
Authorization: Bearer YOUR_FINE_GRAINED_TOKEN
X-GitHub-Api-Version: 2022-11-28
Content-Type: application/json
```

Use a fine-grained GitHub token limited to this repository with **Actions: Read and write** access. The workflows prevent overlapping broad runs and overlapping urgent runs, so slow invocations cannot build an unbounded same-mode queue.

---

## Where to see it running

- Live run list: **https://github.com/coltonrusch/amc-lincoln-square-seat-watcher/actions**
- Click any run to see full logs — every showtime scanned, seat counts, and email-send confirmations.

---

## Troubleshooting

**"I'm not getting emails"**
- Check spam (Gmail often filters messages sent from yourself to yourself).
- Check the latest run's logs. If you see `Email sent to …` lines, the delivery succeeded from our end — it's a Gmail inbox issue.
- If you see `Email send failed: Invalid login`, the `GMAIL_APP_PASSWORD` secret is wrong. Regenerate at https://myaccount.google.com/apppasswords and update:
  ```bash
  gh secret set GMAIL_APP_PASSWORD --repo coltonrusch/amc-lincoln-square-seat-watcher --body 'new-app-password'
  ```

**"Actions aren't running"**
- Scheduled runs can pause after **60 days of repo inactivity**. A single commit resets the clock:
  ```bash
  git commit --allow-empty -m "Keep scheduler alive" && git push
  ```
- GitHub's scheduler is best-effort: scheduled runs can be delayed or dropped during platform load. Use the external dispatch above for the time-sensitive urgent scan.

**"How will I know if the watcher breaks?"**
- The job fails when AMC returns no dates or no showtime links, when the scan throws an error, when it times out, or when Gmail rejects an alert.
- Enable GitHub's failed-workflow notifications at **GitHub → Settings → Notifications → System → Actions → Email → Only notify for failed workflows**.
- Failed runs and their detailed logs also appear in the repository's **Actions** tab.
- An independent GitHub health workflow runs every 15 minutes and stays silent when healthy. It alerts if the external scheduler stops dispatching (10 minutes for urgent or 75 minutes for broad), or if successful scans stop (30 minutes for urgent or three hours for broad), then marks itself failed as well.
- A failed page logs its HTTP status, sanitized URL/title/text excerpt, expected-selector counts, and common error markers. No screenshots or other workflow artifacts are stored.

**"The broad scan is hitting the 15-min timeout"**
- Lower `MAX_DATES` in `amc-node.js` (e.g., to 7).

---

## How it works (one paragraph)

GitHub Actions spins up a fresh Ubuntu VM for each scan. `amc-node.js` uses headless Chrome via Puppeteer to open AMC, identify IMAX 70mm Odyssey showings, and count available seats in the target zone. Broad mode covers all configured dates; urgent mode limits work to upcoming showtimes and applies the tiered clock. If a showtime has at least one target seat, it emails every recipient in `NOTIFY_EMAIL`. The VM is then torn down—nothing persists between runs.

---

## Required GitHub secrets

| Secret | What it is |
| --- | --- |
| `GMAIL_USER` | Gmail address to send from |
| `GMAIL_APP_PASSWORD` | 16-char Gmail app password (generate at https://myaccount.google.com/apppasswords — requires 2FA) |
| `NOTIFY_EMAIL` | Comma-separated list of recipient addresses |

---

## Legacy: DevTools console script

The original [`amc-script.js`](./amc-script.js) runs in the browser DevTools console on the AMC site — useful for ad-hoc, one-off seat checks without touching this repo. See the [original project](https://github.com/NameFILIP/amc-good-seats) for that workflow.
