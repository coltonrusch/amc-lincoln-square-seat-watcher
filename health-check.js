#!/usr/bin/env node

const nodemailer = require("nodemailer");

const REPOSITORY = process.env.GITHUB_REPOSITORY;
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const GMAIL_USER = process.env.GMAIL_USER;
const GMAIL_APP_PASSWORD = process.env.GMAIL_APP_PASSWORD;
const NOTIFY_EMAILS = (process.env.NOTIFY_EMAIL || "")
  .split(",")
  .map((email) => email.trim())
  .filter(Boolean);

const WATCHED_WORKFLOWS = [
  { file: "check-seats.yml", label: "Broad scan", staleAfterMinutes: 180 },
  { file: "check-urgent-seats.yml", label: "Urgent scan", staleAfterMinutes: 90 },
];

function requireConfiguration() {
  const missing = [
    ["GITHUB_REPOSITORY", REPOSITORY],
    ["GITHUB_TOKEN", GITHUB_TOKEN],
    ["GMAIL_USER", GMAIL_USER],
    ["GMAIL_APP_PASSWORD", GMAIL_APP_PASSWORD],
    ["NOTIFY_EMAIL", NOTIFY_EMAILS.length > 0],
  ]
    .filter(([, value]) => !value)
    .map(([name]) => name);

  if (missing.length > 0) {
    throw new Error(`Missing required configuration: ${missing.join(", ")}`);
  }
}

async function latestSuccessfulRun(workflowFile) {
  const url = new URL(
    `https://api.github.com/repos/${REPOSITORY}/actions/workflows/${workflowFile}/runs`
  );
  url.searchParams.set("status", "completed");
  url.searchParams.set("per_page", "30");

  const response = await fetch(url, {
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${GITHUB_TOKEN}`,
      "User-Agent": "amc-seat-watcher-health-check",
      "X-GitHub-Api-Version": "2022-11-28",
    },
  });

  if (!response.ok) {
    throw new Error(`GitHub returned ${response.status} for ${workflowFile}`);
  }

  const { workflow_runs: runs } = await response.json();
  const success = runs.find((run) => run.conclusion === "success");
  return success ? new Date(success.updated_at) : null;
}

async function sendHealthAlert(staleChecks) {
  const rows = staleChecks
    .map(({ label, lastSuccess, staleAfterMinutes }) => {
      const status = lastSuccess
        ? `Last successful run: ${lastSuccess.toISOString()}`
        : "No successful run found among the latest 30 completed runs";
      return `<li><strong>${label}</strong>: ${status} (alert threshold: ${staleAfterMinutes} minutes)</li>`;
    })
    .join("");

  const transporter = nodemailer.createTransport({
    service: "gmail",
    auth: { user: GMAIL_USER, pass: GMAIL_APP_PASSWORD },
  });

  await transporter.sendMail({
    from: `"AMC Watcher" <${GMAIL_USER}>`,
    to: NOTIFY_EMAILS,
    subject: `AMC watcher health alert: ${staleChecks.map(({ label }) => label).join(" and ")} stale`,
    html: `
<div style="font-family:system-ui,sans-serif;">
  <h2>AMC watcher needs attention</h2>
  <ul>${rows}</ul>
  <p><a href="https://github.com/${REPOSITORY}/actions">Open GitHub Actions →</a></p>
</div>`,
  });
}

async function main() {
  requireConfiguration();
  const now = Date.now();
  const checks = [];

  for (const workflow of WATCHED_WORKFLOWS) {
    const lastSuccess = await latestSuccessfulRun(workflow.file);
    const ageMinutes = lastSuccess ? (now - lastSuccess.getTime()) / 60000 : Infinity;
    checks.push({ ...workflow, lastSuccess, ageMinutes });
    console.log(
      `${workflow.label}: ${lastSuccess ? `${Math.round(ageMinutes)} minutes since success` : "no success found"}`
    );
  }

  const staleChecks = checks.filter(({ ageMinutes, staleAfterMinutes }) => ageMinutes > staleAfterMinutes);
  if (staleChecks.length === 0) {
    console.log("Watcher is healthy; no email sent.");
    return;
  }

  await sendHealthAlert(staleChecks);
  throw new Error(`${staleChecks.map(({ label }) => label).join(" and ")} exceeded the health threshold.`);
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
