#!/usr/bin/env node
/*
 * AMC IMAX 70mm Seat Watcher — Lincoln Square, NYC
 *
 * One-shot scan. Designed to be invoked on a schedule (GitHub Actions cron).
 * Emails a summary via Gmail SMTP when target seats are available.
 *
 * Env vars (required for email):
 *   GMAIL_USER          — Gmail address to send from
 *   GMAIL_APP_PASSWORD  — Gmail app password (2FA required)
 *   NOTIFY_EMAIL        — recipient address(es), comma-separated
 */

const puppeteer = require("puppeteer-extra");
const StealthPlugin = require("puppeteer-extra-plugin-stealth");
const nodemailer = require("nodemailer");
puppeteer.use(StealthPlugin());

// ─── Config ─────────────────────────────────────────────────────────────────

const MOVIES = [
  "the odyssey",
];

const MIN_SHOWTIME_MINUTES = 0;

const THEATER_URL =
  "https://www.amctheatres.com/movie-theatres/new-york-city/amc-lincoln-square-13/showtimes";

const TEST_MODE = process.env.TEST_MODE === "true" || process.env.TEST_MODE === "1";
const SCAN_MODE = process.env.SCAN_MODE === "urgent" ? "urgent" : "broad";
const FORCE_URGENT_SCAN =
  process.env.FORCE_URGENT_SCAN === "true" || process.env.FORCE_URGENT_SCAN === "1";

const MAX_DATES = 14;
const DATE_SCAN_CONCURRENCY = 3;
const SEAT_SCAN_CONCURRENCY = 3;
const NAVIGATION_ATTEMPTS = 3;
const ADVANCE_DATE_WINDOWS = [
  {
    label: "The Odyssey",
    start: "2026-07-16",
    end: "2026-08-31",
  },
];
const MIN_SEATS_FOR_EMAIL = 1;
const THEATER_TIME_ZONE = "America/New_York";
const URGENT_WINDOW_MINUTES = 48 * 60;
const URGENT_BASE_INTERVAL_MINUTES = 2;

const TARGET_ROWS = TEST_MODE
  ? ["A", "B", "C", "D", "E", "F", "G", "H", "J", "K", "L", "M", "N", "P"]
  : ["F", "G", "H", "J"];
const TARGET_COL_MIN = TEST_MODE ? 1 : 9;
const TARGET_COL_MAX = TEST_MODE ? 100 : 39;

const GMAIL_USER = process.env.GMAIL_USER;
const GMAIL_APP_PASSWORD = process.env.GMAIL_APP_PASSWORD;
const NOTIFY_EMAILS = (process.env.NOTIFY_EMAIL || "")
  .split(",")
  .map((e) => e.trim())
  .filter(Boolean);

// ─── Helpers ────────────────────────────────────────────────────────────────

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function ts() {
  return new Date().toLocaleString();
}

function log(msg) {
  console.log(`[${ts()}] ${msg}`);
}

function parseShowtimeMinutes(timeText) {
  const m = timeText.trim().match(/^(\d{1,2}):(\d{2})\s*(am|pm)$/i);
  if (!m) return null;
  let h = parseInt(m[1], 10);
  const min = parseInt(m[2], 10);
  const ampm = m[3].toLowerCase();
  if (ampm === "pm" && h !== 12) h += 12;
  if (ampm === "am" && h === 12) h = 0;
  return h * 60 + min;
}

function getZonedDateParts(date, timeZone) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);

  return Object.fromEntries(
    parts.filter(({ type }) => type !== "literal").map(({ type, value }) => [type, Number(value)])
  );
}

function parseShowtimeDateTime(dateText, timeText) {
  const minutes = parseShowtimeMinutes(timeText);
  if (minutes === null) return null;

  const [year, month, day] = dateText.split("-").map(Number);
  const hour = Math.floor(minutes / 60);
  const minute = minutes % 60;
  const desiredUtc = Date.UTC(year, month - 1, day, hour, minute, 0);
  let instant = desiredUtc;

  // Convert a wall-clock time at the theater into an instant. Repeating the
  // adjustment handles both standard/daylight offsets without hard-coding EDT.
  for (let attempt = 0; attempt < 2; attempt++) {
    const observed = getZonedDateParts(new Date(instant), THEATER_TIME_ZONE);
    const observedUtc = Date.UTC(
      observed.year,
      observed.month - 1,
      observed.day,
      observed.hour,
      observed.minute,
      observed.second
    );
    instant += desiredUtc - observedUtc;
  }

  return new Date(instant);
}

function localDateString(date) {
  const { year, month, day } = getZonedDateParts(date, THEATER_TIME_ZONE);
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

function urgentDateStrings(now) {
  const dates = [];
  for (let offset = 0; offset <= 2; offset++) {
    dates.push(localDateString(new Date(now.getTime() + offset * 24 * 60 * 60 * 1000)));
  }
  return [...new Set(dates)];
}

function urgentCadenceMinutes(minutesUntil) {
  if (minutesUntil <= 4 * 60) return 2;
  if (minutesUntil <= 12 * 60) return 5;
  return 10;
}

function isUrgentScanDue(minutesUntil, now = new Date()) {
  if (FORCE_URGENT_SCAN) return true;
  const cadence = urgentCadenceMinutes(minutesUntil);
  const currentMinute = Math.floor(now.getTime() / 60000);
  return currentMinute % cadence < URGENT_BASE_INTERVAL_MINUTES;
}

function formatCountdown(minutesUntil) {
  const totalMinutes = Math.max(0, Math.ceil(minutesUntil));
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours === 0) return `${minutes}m`;
  if (minutes === 0) return `${hours}h`;
  return `${hours}h ${minutes}m`;
}

async function withFreshPageRetry(browser, label, task) {
  let lastError;

  for (let attempt = 1; attempt <= NAVIGATION_ATTEMPTS; attempt++) {
    const context = await browser.createBrowserContext();
    const page = await context.newPage();

    try {
      return await task(page);
    } catch (err) {
      lastError = err;
      if (attempt < NAVIGATION_ATTEMPTS) {
        const delay = 1000 * 2 ** (attempt - 1) + Math.random() * 1000;
        log(`${label} failed (attempt ${attempt}/${NAVIGATION_ATTEMPTS}): ${err.message} — retrying`);
        await sleep(delay);
      }
    } finally {
      await context.close().catch(() => {});
    }
  }

  throw new Error(`${label} failed after ${NAVIGATION_ATTEMPTS} attempts: ${lastError.message}`);
}

async function navigateToListings(page, url) {
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 });
  await page.waitForSelector('select[name="date"]', { timeout: 30000 });
  await sleep(1500);
}

async function mapWithConcurrency(items, limit, worker) {
  const results = new Array(items.length);
  let nextIndex = 0;

  async function runWorker() {
    while (nextIndex < items.length) {
      const index = nextIndex++;
      results[index] = await worker(items[index], index);
    }
  }

  const workerCount = Math.min(limit, items.length);
  await Promise.all(Array.from({ length: workerCount }, () => runWorker()));
  return results;
}

async function mapWithConcurrencySettled(items, limit, worker) {
  const results = new Array(items.length);
  let nextIndex = 0;

  async function runWorker() {
    while (nextIndex < items.length) {
      const index = nextIndex++;
      try {
        results[index] = {
          status: "fulfilled",
          value: await worker(items[index], index),
        };
      } catch (reason) {
        results[index] = { status: "rejected", reason };
      }
    }
  }

  const workerCount = Math.min(limit, items.length);
  await Promise.all(Array.from({ length: workerCount }, () => runWorker()));
  return results;
}

async function sendEmail(subject, html) {
  if (!GMAIL_USER || !GMAIL_APP_PASSWORD || NOTIFY_EMAILS.length === 0) {
    log("GMAIL_USER / GMAIL_APP_PASSWORD / NOTIFY_EMAIL not set — skipping email.");
    return;
  }
  const transporter = nodemailer.createTransport({
    service: "gmail",
    auth: { user: GMAIL_USER, pass: GMAIL_APP_PASSWORD },
  });
  try {
    await transporter.sendMail({
      from: `"AMC Watcher" <${GMAIL_USER}>`,
      to: NOTIFY_EMAILS,
      subject,
      html,
    });
    log(`Email sent to ${NOTIFY_EMAILS.join(", ")}.`);
  } catch (err) {
    log(`Email send failed: ${err.message}`);
    throw err;
  }
}

// ─── Scraping ───────────────────────────────────────────────────────────────

async function getShowtimes(browser, date) {
  const url = date ? `${THEATER_URL}?date=${date}` : THEATER_URL;
  return withFreshPageRetry(browser, `Showtimes for ${date}`, async (page) => {
    await navigateToListings(page, url);

    return page.evaluate((movieTerms) => {
      const links = document.querySelectorAll("a[href*='/showtimes/']");
      const results = [];

      for (const link of links) {
        const href = link.href;
        const idMatch = href.match(/\/showtimes\/(\d+)/);
        if (!idMatch) continue;

        const showtimeId = idMatch[1];
        const timeText = link.innerText.trim().split("\n")[0];
        const isSoldOut = link.innerText.includes("Sold Out");

        const formatLi = link.closest("ul")?.closest("li");
        const isImax70mm = formatLi
          ? (formatLi.innerText || "").includes("IMAX 70MM")
          : false;
        if (!isImax70mm) continue;

        const section = link.closest("section");
        const movieHeading = section?.querySelector("h1");
        const movieName = movieHeading ? movieHeading.innerText.trim() : "";

        const lower = movieName.toLowerCase();
        const matches = movieTerms.some((term) => lower.includes(term));
        if (!matches) continue;

        results.push({
          id: showtimeId,
          movie: movieName,
          time: timeText,
          soldOut: isSoldOut,
        });
      }
      return { showtimes: results, showtimeLinkCount: links.length };
    }, MOVIES);
  });
}

async function getAvailableDates(browser) {
  return withFreshPageRetry(browser, "Available dates", async (page) => {
    await navigateToListings(page, THEATER_URL);

    return page.evaluate(() => {
      const options = document.querySelectorAll('select[name="date"] option');
      return Array.from(options)
        .map((o) => o.value)
        .filter((v) => v && /^\d{4}-\d{2}-\d{2}$/.test(v));
    });
  });
}

async function getAvailableSeats(browser, showtimeId) {
  const url = `https://www.amctheatres.com/showtimes/${showtimeId}`;
  return withFreshPageRetry(browser, `Seat map ${showtimeId}`, async (page) => {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 });
    await page.waitForSelector("input[aria-label]", { timeout: 30000 });
    await sleep(1500);

    return page.evaluate(
      (rows, colMin, colMax) => {
        const inputs = document.querySelectorAll("input[aria-label]");
        const available = [];
        for (const input of inputs) {
          const label = input.getAttribute("aria-label");
          if (label.startsWith("Occupied")) continue;
          const match = label.match(/([A-Z])(\d+)$/);
          if (!match) continue;
          const row = match[1];
          const col = parseInt(match[2], 10);
          if (rows.includes(row) && col >= colMin && col <= colMax) {
            available.push(row + col);
          }
        }
        available.sort((a, b) => {
          if (a[0] !== b[0]) return a[0].localeCompare(b[0]);
          return parseInt(a.slice(1)) - parseInt(b.slice(1));
        });
        return available;
      },
      TARGET_ROWS,
      TARGET_COL_MIN,
      TARGET_COL_MAX
    );
  });
}

// ─── Scan ───────────────────────────────────────────────────────────────────

async function runFullScan(browser) {
  log("Scanning AMC Lincoln Square 13 — IMAX 70mm");
  log(`Mode: ${SCAN_MODE}`);
  log(`Target: ${MOVIES.join(", ")}`);
  log(`Seats: rows ${TARGET_ROWS.join("/")} cols ${TARGET_COL_MIN}-${TARGET_COL_MAX}`);

  const allDates = await getAvailableDates(browser);
  if (allDates.length === 0) {
    throw new Error("AMC returned no selectable dates; the site may be unavailable or its markup may have changed.");
  }

  const scanStartedAt = new Date();
  let dates;

  if (SCAN_MODE === "urgent") {
    const urgentDates = new Set(urgentDateStrings(scanStartedAt));
    dates = allDates.filter((date) => urgentDates.has(date));
    log(`Scanning ${dates.length} near-term date(s): ${dates.join(", ")}`);
  } else {
    const rollingDates = allDates.slice(0, MAX_DATES);
    const advanceDates = allDates.filter((date) =>
      ADVANCE_DATE_WINDOWS.some(({ start, end }) => date >= start && date <= end)
    );
    dates = [...new Set([...rollingDates, ...advanceDates])].sort();
    log(`Scanning ${dates.length} of ${allDates.length} dates (${rollingDates.length} rolling, ${advanceDates.length} advance-window)`);
    for (const { label, start, end } of ADVANCE_DATE_WINDOWS) {
      log(`Advance window: ${label} (${start} -> ${end})`);
    }
  }

  if (dates.length === 0) {
    throw new Error(`${SCAN_MODE} scan selected no AMC dates; the site's date list may have changed.`);
  }

  let emailsSent = 0;
  let totalHits = 0;
  let totalShowtimeLinks = 0;
  const showtimesToScan = [];

  const dateResults = await mapWithConcurrency(
    dates,
    DATE_SCAN_CONCURRENCY,
    (date) => getShowtimes(browser, date)
  );

  for (let index = 0; index < dates.length; index++) {
    const date = dates[index];
    const { showtimes, showtimeLinkCount } = dateResults[index];
    totalShowtimeLinks += showtimeLinkCount;
    if (showtimes.length === 0) continue;

    log(`  ${date}: ${showtimes.length} IMAX 70mm showtime(s)`);

    for (const st of showtimes) {
      if (st.soldOut) {
        log(`    ${st.time} ${st.movie} — SOLD OUT`);
        continue;
      }

      const stMinutes = parseShowtimeMinutes(st.time);
      if (stMinutes !== null && stMinutes < MIN_SHOWTIME_MINUTES) {
        log(`    ${st.time} ${st.movie} — before configured cutoff, skipping`);
        continue;
      }

      if (SCAN_MODE === "urgent") {
        const startsAt = parseShowtimeDateTime(date, st.time);
        if (!startsAt) {
          throw new Error(`Could not parse showtime ${date} ${st.time} (${st.id}).`);
        }

        const minutesUntil = (startsAt.getTime() - scanStartedAt.getTime()) / 60000;
        if (minutesUntil <= 0) {
          log(`    ${st.time} ${st.movie} — already started, skipping`);
          continue;
        }
        if (minutesUntil > URGENT_WINDOW_MINUTES) {
          log(`    ${st.time} ${st.movie} — outside 48-hour urgent window, skipping`);
          continue;
        }

        const cadenceMinutes = urgentCadenceMinutes(minutesUntil);
        if (!isUrgentScanDue(minutesUntil, scanStartedAt)) {
          log(`    ${st.time} ${st.movie} — starts in ${formatCountdown(minutesUntil)}; ${cadenceMinutes}m tier not due`);
          continue;
        }

        showtimesToScan.push({ date, st, startsAt, minutesUntil, cadenceMinutes });
      } else {
        showtimesToScan.push({ date, st });
      }
    }
  }

  if (totalShowtimeLinks === 0) {
    throw new Error("AMC returned no showtime links across all scanned dates; the site may be unavailable or its markup may have changed.");
  }

  log(`Checking ${showtimesToScan.length} seat maps with concurrency ${SEAT_SCAN_CONCURRENCY}`);
  const settledSeatResults = await mapWithConcurrencySettled(
    showtimesToScan,
    SEAT_SCAN_CONCURRENCY,
    async ({ date, st, startsAt, cadenceMinutes }) => ({
      date,
      st,
      startsAt,
      cadenceMinutes,
      seats: await getAvailableSeats(browser, st.id),
    })
  );

  const seatFailures = [];

  for (let index = 0; index < settledSeatResults.length; index++) {
    const result = settledSeatResults[index];
    if (result.status === "rejected") {
      const { date, st } = showtimesToScan[index];
      seatFailures.push({ date, st, error: result.reason });
      log(`    ${date} ${st.time} ${st.movie} — seat map failed; continuing with other showtimes`);
      continue;
    }

    const { date, st, seats } = result.value;
    const minutesUntil = (result.value.startsAt?.getTime() - Date.now()) / 60000;
    const countdown = Number.isFinite(minutesUntil) ? formatCountdown(minutesUntil) : null;
    if (seats.length === 0) {
      log(`    ${st.time} ${st.movie} — no target seats`);
    } else if (seats.length < MIN_SEATS_FOR_EMAIL) {
      log(`    ${st.time} ${st.movie} — ${seats.length} seat (below ${MIN_SEATS_FOR_EMAIL}-seat threshold): ${seats.join(", ")}`);
    } else {
      totalHits++;
      log(`    ${st.time} ${st.movie} — ${seats.length} seats: ${seats.join(", ")} → emailing`);
      const subject = countdown
        ? `AMC in ${countdown}: ${seats.length} seats — ${st.movie} · ${date} ${st.time}`
        : `AMC IMAX 70mm: ${seats.length} seats — ${st.movie} · ${date} ${st.time}`;
      const html = `
<div style="font-family:system-ui,sans-serif;">
  <h2 style="margin:0 0 8px 0;">${st.movie}</h2>
  <p style="margin:0 0 8px 0;color:#555;">${date} &middot; ${st.time}</p>
  ${countdown ? `<p style="margin:0 0 8px 0;"><strong>Starts in ${countdown}</strong></p>` : ""}
  <p style="margin:0 0 8px 0;"><strong>${seats.length} seat${seats.length === 1 ? "" : "s"} available</strong> in target zone (rows ${TARGET_ROWS.join("/")}, cols ${TARGET_COL_MIN}-${TARGET_COL_MAX}):</p>
  <p style="margin:0 0 12px 0;font-family:ui-monospace,monospace;">${seats.join(", ")}</p>
  <p style="margin:0;"><a href="https://www.amctheatres.com/showtimes/${st.id}">Book now →</a></p>
</div>`;
      await sendEmail(subject, html);
      emailsSent++;
      await sleep(1000 + Math.random() * 1000);
    }
  }

  if (totalHits === 0) {
    log(`No showtimes with ${MIN_SEATS_FOR_EMAIL}+ target seats found this scan.`);
  } else {
    log(`Scan complete. ${emailsSent} email(s) sent for ${totalHits} showtime hit(s).`);
  }

  if (seatFailures.length > 0) {
    const failedIds = seatFailures.map(({ st }) => st.id).join(", ");
    throw new Error(
      `${seatFailures.length} seat map(s) failed after retries (${failedIds}). All other showtimes were processed.`
    );
  }
}

// ─── Entry ──────────────────────────────────────────────────────────────────

async function main() {
  log("AMC IMAX 70mm Seat Watcher — single scan");

  if (!GMAIL_USER || !GMAIL_APP_PASSWORD || NOTIFY_EMAILS.length === 0) {
    throw new Error("GMAIL_USER, GMAIL_APP_PASSWORD, and NOTIFY_EMAIL must all be configured.");
  }

  const browser = await puppeteer.launch({
    headless: "new",
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
  });

  let exitCode = 0;
  try {
    await runFullScan(browser);
  } catch (err) {
    log(`Scan error: ${err.stack || err.message}`);
    exitCode = 1;
  } finally {
    await browser.close();
  }
  process.exit(exitCode);
}

if (require.main === module) {
  main();
}

module.exports = {
  formatCountdown,
  isUrgentScanDue,
  parseShowtimeDateTime,
  urgentCadenceMinutes,
  urgentDateStrings,
};
