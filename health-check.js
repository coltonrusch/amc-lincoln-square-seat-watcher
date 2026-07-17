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
  {
    file: "check-seats.yml",
    label: "Broad scan",
    dispatchStaleAfterMinutes: 75,
    successStaleAfterMinutes: 180,
  },
  {
    file: "check-urgent-seats.yml",
    label: "Urgent scan",
    dispatchStaleAfterMinutes: 10,
    successStaleAfterMinutes: 30,
  },
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

async function latestWorkflowActivity(workflowFile) {
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
  const latestRun = runs[0];
  const success = runs.find((run) => run.conclusion === "success");
  return {
    latestDispatch: latestRun ? new Date(latestRun.created_at) : null,
    latestSuccess: success ? new Date(success.updated_at) : null,
  };
}

async function sendHealthAlert(unhealthyChecks) {
  const rows = unhealthyChecks
    .map(({ label, latestDispatch, latestSuccess, issues }) => {
      const dispatchStatus = latestDispatch
        ? `Last dispatch: ${latestDispatch.toISOString()}`
        : "No completed dispatch found";
      const successStatus = latestSuccess
        ? `last success: ${latestSuccess.toISOString()}`
        : "no success found among the latest 30 completed runs";
      return `<li><strong>${label}</strong>: ${issues.join("; ")} (${dispatchStatus}; ${successStatus})</li>`;
    })
    .join("");

  const transporter = nodemailer.createTransport({
    service: "gmail",
    auth: { user: GMAIL_USER, pass: GMAIL_APP_PASSWORD },
  });

  await transporter.sendMail({
    from: `"AMC Watcher" <${GMAIL_USER}>`,
    to: NOTIFY_EMAILS,
    subject: `AMC watcher health alert: ${unhealthyChecks.map(({ label }) => label).join(" and ")} unhealthy`,
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
    const { latestDispatch, latestSuccess } = await latestWorkflowActivity(workflow.file);
    const dispatchAgeMinutes = latestDispatch ? (now - latestDispatch.getTime()) / 60000 : Infinity;
    const successAgeMinutes = latestSuccess ? (now - latestSuccess.getTime()) / 60000 : Infinity;
    const issues = [];
    if (dispatchAgeMinutes > workflow.dispatchStaleAfterMinutes) {
      issues.push(`no dispatch within ${workflow.dispatchStaleAfterMinutes} minutes`);
    }
    if (successAgeMinutes > workflow.successStaleAfterMinutes) {
      issues.push(`no success within ${workflow.successStaleAfterMinutes} minutes`);
    }
    checks.push({
      ...workflow,
      latestDispatch,
      latestSuccess,
      dispatchAgeMinutes,
      successAgeMinutes,
      issues,
    });
    console.log(
      `${workflow.label}: ${latestDispatch ? `${Math.round(dispatchAgeMinutes)} minutes since dispatch` : "no dispatch found"}; ` +
        `${latestSuccess ? `${Math.round(successAgeMinutes)} minutes since success` : "no success found"}`
    );
  }

  const unhealthyChecks = checks.filter(({ issues }) => issues.length > 0);
  if (unhealthyChecks.length === 0) {
    console.log("Watcher is healthy; no email sent.");
    return;
  }

  await sendHealthAlert(unhealthyChecks);
  throw new Error(`${unhealthyChecks.map(({ label }) => label).join(" and ")} exceeded a health threshold.`);
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
