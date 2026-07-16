const test = require("node:test");
const assert = require("node:assert/strict");

const {
  formatCountdown,
  isUrgentScanDue,
  parseShowtimeDateTime,
  urgentCadenceMinutes,
  urgentDateStrings,
} = require("./amc-node");

test("parses New York showtimes with the correct seasonal UTC offset", () => {
  assert.equal(
    parseShowtimeDateTime("2026-07-16", "10:00am").toISOString(),
    "2026-07-16T14:00:00.000Z"
  );
  assert.equal(
    parseShowtimeDateTime("2026-01-16", "10:00am").toISOString(),
    "2026-01-16T15:00:00.000Z"
  );
});

test("selects all local dates that can intersect the next 48 hours", () => {
  assert.deepEqual(urgentDateStrings(new Date("2026-07-16T16:00:00Z")), [
    "2026-07-16",
    "2026-07-17",
    "2026-07-18",
  ]);
});

test("assigns urgent cadence tiers", () => {
  assert.equal(urgentCadenceMinutes(60), 2);
  assert.equal(urgentCadenceMinutes(240), 2);
  assert.equal(urgentCadenceMinutes(241), 5);
  assert.equal(urgentCadenceMinutes(720), 5);
  assert.equal(urgentCadenceMinutes(721), 10);
});

test("two-minute dispatch clock selects the appropriate cadence buckets", () => {
  assert.equal(isUrgentScanDue(60, new Date(2 * 60000)), true);
  assert.equal(isUrgentScanDue(300, new Date(2 * 60000)), false);
  assert.equal(isUrgentScanDue(300, new Date(5 * 60000)), true);
  assert.equal(isUrgentScanDue(1000, new Date(10 * 60000)), true);
});

test("formats concise countdowns", () => {
  assert.equal(formatCountdown(43.2), "44m");
  assert.equal(formatCountdown(120), "2h");
  assert.equal(formatCountdown(138), "2h 18m");
});
