// Turns the JSON that `cloudpin check --json` prints into the step's job
// summary, error annotations, `result` output and exit code. No dependencies:
// the runner's own node runs it. It shows only cloudpin's own texts (problems,
// fix, error), which never contain a credential value.
//
// Fail closed: the exit code is 0 only for a well-formed report whose result is
// "match" or "unpinned" and whose clouds agree with that result. Anything else
// (not JSON, an unknown result or status, a missing file) is result "error".

import { appendFileSync, readFileSync, realpathSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HEADINGS = {
  match: "all checked accounts match",
  mismatch: "account mismatch, deploy stopped",
  unpinned: "nothing is pinned",
  error: "could not check",
};
const UNREADABLE = "could not read cloudpin's result";
const STATUSES = ["match", "mismatch", "not-logged-in", "unknown", "not-installed", "unsupported"];

/** Whether a cloud's status fails the check: everything but match, and not-installed outside --only. */
const failing = (entry, strict) => entry.status !== "match" && (strict || entry.status !== "not-installed");

/** GitHub workflow-command escaping for the message part. */
const escapeData = (text) => text.replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A");
/** ... and for a property value such as title. */
const escapeProperty = (text) => escapeData(text).replace(/:/g, "%3A").replace(/,/g, "%2C");

/** Text for Markdown: HTML-escaped so a fix's <placeholder> shows, one line. */
const escapeMarkdown = (text) =>
  text
    .replace(/\\/g, "\\\\")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\r/g, "")
    .replace(/\n/g, "<br>");
const escapeCell = (text) => escapeMarkdown(text).replace(/\|/g, "\\|");

/** "problem; problem; fix: fix" for one cloud. */
function details(entry) {
  const parts = [...entry.problems];
  if (entry.fix !== undefined) parts.push(`fix: ${entry.fix}`);
  return parts.join("; ");
}

/** The report, or a string saying why it can't be trusted. */
function parse(jsonText) {
  let report;
  try {
    report = JSON.parse(jsonText);
  } catch {
    return jsonText.trim() === "" ? "cloudpin printed nothing" : "it is not JSON (cloudpin 1.2.0 or later is needed)";
  }
  if (report === null || typeof report !== "object" || Array.isArray(report)) return "it is not a JSON object";
  if (!Object.hasOwn(HEADINGS, report.result)) return `unknown result ${JSON.stringify(report.result)}`;
  if (!Array.isArray(report.providers)) return "it has no providers list";
  for (const entry of report.providers) {
    const ok =
      entry !== null &&
      typeof entry === "object" &&
      typeof entry.provider === "string" &&
      STATUSES.includes(entry.status) &&
      Array.isArray(entry.problems) &&
      entry.problems.every((p) => typeof p === "string") &&
      (entry.fix === undefined || typeof entry.fix === "string");
    if (!ok) return `unexpected provider entry ${JSON.stringify(entry)}`;
  }
  if (report.error !== undefined && typeof report.error !== "string") return "its error is not text";
  if (report.only !== undefined && !Array.isArray(report.only)) return "its only list is not a list";
  const strict = report.only !== undefined;
  if ((report.result === "match" || report.result === "unpinned") && report.providers.some((e) => failing(e, strict))) {
    return `result "${report.result}" disagrees with its clouds`;
  }
  if (report.result === "unpinned" && (report.providers.length > 0 || strict)) {
    return 'result "unpinned" with clouds to check';
  }
  return report;
}

/**
 * The providers a plain `cloudpin check --json` found pinned, joined with
 * commas for the strict second pass (`--only`). Empty means "keep this
 * report": nothing pinned, an error, or a report that can't be read (which
 * summarize then fails). A name that isn't a plain provider name throws, so
 * the action stops rather than falling back to the lax first report.
 * @param {string} jsonText
 * @returns {string}
 */
export function pinnedProviders(jsonText) {
  const report = parse(jsonText);
  if (typeof report === "string" || (report.result !== "match" && report.result !== "mismatch")) return "";
  const names = report.providers.map((entry) => entry.provider);
  const bad = names.find((name) => !/^[a-z][a-z0-9-]*$/.test(name));
  if (bad !== undefined) throw new Error(`unexpected provider name ${JSON.stringify(bad)} in cloudpin's result`);
  return names.join(",");
}

/**
 * @param {string} jsonText what `cloudpin check --json` printed on stdout
 * @param {{ cloudpinExit?: number }} [opts] cloudpin's own exit code, when known
 * @returns {{ result: "match"|"mismatch"|"unpinned"|"error", exitCode: 0|1, summary: string, annotations: string[], log: string[] }}
 */
export function summarize(jsonText, opts = {}) {
  const report = parse(jsonText);
  if (typeof report === "string") return unreadable(report);
  const passing = report.result === "match" || report.result === "unpinned";
  if (passing && opts.cloudpinExit !== undefined && opts.cloudpinExit !== 0) {
    return unreadable(`it says "${report.result}", but cloudpin exited with code ${opts.cloudpinExit}`);
  }

  const strict = report.only !== undefined;
  const lines = [`### cloudpin: ${HEADINGS[report.result]}`, ""];
  const log = [`cloudpin: ${HEADINGS[report.result]}`];
  if (typeof report.path === "string") {
    let where = `Pin file: ${escapeMarkdown(report.path)}`;
    const env = report.environment;
    if (env && typeof env.name === "string") {
      where += `, environment ${escapeMarkdown(env.name)}${env.protected === true ? " (protected)" : ""}`;
      if (typeof env.source === "string") where += `, chosen by ${escapeMarkdown(env.source)}`;
    }
    lines.push(where, "");
  }
  if (report.providers.length > 0) {
    lines.push("| Cloud | Status | Details |", "|---|---|---|");
    for (const entry of report.providers) {
      lines.push(`| ${escapeCell(entry.provider)} | ${escapeCell(entry.status)} | ${escapeCell(details(entry))} |`);
      log.push(`  ${entry.provider}: ${entry.status}${details(entry) ? ` (${details(entry)})` : ""}`);
    }
    lines.push("");
  }
  if (report.error !== undefined) {
    lines.push(escapeMarkdown(report.error), "");
    log.push(`  ${report.error}`);
  }

  const annotations = [];
  for (const entry of report.providers) {
    if (!failing(entry, strict)) continue;
    const message = details(entry) || entry.status;
    annotations.push(`::error title=${escapeProperty(`cloudpin ${entry.provider}`)}::${escapeData(message)}`);
  }
  if (report.error !== undefined) annotations.push(`::error title=cloudpin::${escapeData(report.error)}`);

  return { result: report.result, exitCode: passing ? 0 : 1, summary: lines.join("\n"), annotations, log };
}

/** The outcome when there is no trustworthy report: always a failure. */
function unreadable(reason) {
  const message = `${UNREADABLE}: ${reason}`;
  return {
    result: "error",
    exitCode: 1,
    summary: `### cloudpin: ${HEADINGS.error}\n\n${escapeMarkdown(message)}.\n`,
    annotations: [`::error title=cloudpin::${escapeData(message)}`],
    log: [`cloudpin: ${message}`],
  };
}

const readOrUndefined = (file) => {
  try {
    return readFileSync(file, "utf8");
  } catch {
    return undefined;
  }
};

/**
 * `node report.mjs <json-file> [cloudpin-exit-code]`: the action's last step.
 * `node report.mjs --pinned <json-file>`: prints pinnedProviders for the first pass.
 */
function main(argv, env) {
  if (argv[0] === "--pinned") {
    try {
      console.log(pinnedProviders(readOrUndefined(argv[1] ?? "") ?? ""));
      return 0;
    } catch (err) {
      console.log(`::error title=cloudpin::${escapeData(err.message)}`);
      return 1;
    }
  }
  const [file, exitArg] = argv;
  let outcome;
  if (file === undefined) {
    outcome = unreadable("no report file was given");
  } else if (exitArg !== undefined && !/^[0-9]+$/.test(exitArg)) {
    outcome = unreadable(`cloudpin's exit code ${JSON.stringify(exitArg)} is not a number`);
  } else {
    const text = readOrUndefined(file);
    const opts = exitArg === undefined ? {} : { cloudpinExit: Number(exitArg) };
    outcome = text === undefined ? unreadable("the report file is missing") : summarize(text, opts);
  }
  for (const line of outcome.log) console.log(line);
  for (const line of outcome.annotations) console.log(line);
  // Missing env files are skipped, so it also runs outside GitHub Actions.
  if (env.GITHUB_STEP_SUMMARY) appendFileSync(env.GITHUB_STEP_SUMMARY, `${outcome.summary}\n`);
  if (env.GITHUB_OUTPUT) appendFileSync(env.GITHUB_OUTPUT, `result=${outcome.result}\n`);
  return outcome.exitCode;
}

/** True when node was started on this file (not when a test imports it). */
function isEntryPoint() {
  if (!process.argv[1]) return false;
  try {
    const norm = (p) => {
      const real = realpathSync(resolve(p));
      return process.platform === "win32" ? real.toLowerCase() : real;
    };
    return norm(process.argv[1]) === norm(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isEntryPoint()) process.exitCode = main(process.argv.slice(2), process.env);
