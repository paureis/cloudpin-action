import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { summarize } from "../src/report.mjs";

// Reports printed by `cloudpin check --json --only kubernetes` (cloudpin main,
// 4182a1b) against a kubeconfig whose context points at https://a.example.invalid.
// Only the pin file path was replaced by a runner-style one.
const PATH = "/home/runner/work/app/app/.cloudpin.yml";
const MATCH = {
  result: "match",
  path: PATH,
  environment: null,
  only: ["kubernetes"],
  providers: [{ provider: "kubernetes", status: "match", problems: [] }],
};
const MISMATCH = {
  result: "mismatch",
  path: PATH,
  environment: null,
  only: ["kubernetes"],
  providers: [
    {
      provider: "kubernetes",
      status: "mismatch",
      problems: ['server: expected "https://b.example.invalid", active is "https://a.example.invalid" (context "fake")'],
      fix: "kubectl config get-contexts, then kubectl config use-context <the context for https://b.example.invalid>",
    },
  ],
};
const UNPINNED = { result: "unpinned", path: null, environment: null, providers: [] };
const ERROR = { result: "error", path: null, environment: null, error: "invalid config: x", providers: [] };

const run = (report) => summarize(typeof report === "string" ? report : JSON.stringify(report, null, 2));

test("match passes with no annotations", () => {
  const out = run(MATCH);
  assert.equal(out.result, "match");
  assert.equal(out.exitCode, 0);
  assert.ok(out.summary.startsWith("### cloudpin: all checked accounts match"), out.summary);
  assert.match(out.summary, /\| Cloud \| Status \| Details \|/);
  assert.match(out.summary, /\| kubernetes \| match \|/);
  assert.deepEqual(out.annotations, []);
});

test("mismatch fails with one annotation per failing cloud", () => {
  const out = run(MISMATCH);
  assert.equal(out.result, "mismatch");
  assert.equal(out.exitCode, 1);
  assert.ok(out.summary.startsWith("### cloudpin: account mismatch, deploy stopped"), out.summary);
  assert.equal(out.annotations.length, 1);
  assert.ok(out.annotations[0].startsWith("::error title=cloudpin kubernetes::server: expected"), out.annotations[0]);
  assert.match(out.annotations[0], /; fix: kubectl config get-contexts/);
  const row = out.summary.split("\n").find((line) => line.startsWith("| kubernetes "));
  assert.ok(row, out.summary);
  assert.match(row, /\| mismatch \|/);
  assert.match(row, /fix: kubectl config get-contexts/);
});

test("the fix's <placeholder> is escaped so the summary shows it", () => {
  const out = run(MISMATCH);
  assert.match(out.summary, /&lt;the context for https:\/\/b\.example\.invalid&gt;/);
  assert.doesNotMatch(out.summary, /<the context/);
});

test("unpinned passes", () => {
  const out = run(UNPINNED);
  assert.equal(out.result, "unpinned");
  assert.equal(out.exitCode, 0);
  assert.ok(out.summary.startsWith("### cloudpin: nothing is pinned"), out.summary);
  assert.deepEqual(out.annotations, []);
});

test("error fails and annotates cloudpin's message", () => {
  const out = run(ERROR);
  assert.equal(out.result, "error");
  assert.equal(out.exitCode, 1);
  assert.ok(out.summary.startsWith("### cloudpin: could not check"), out.summary);
  assert.match(out.summary, /invalid config: x/);
  assert.deepEqual(out.annotations, ["::error title=cloudpin::invalid config: x"]);
});

for (const [name, text] of [
  ["text that is not JSON", "cloudpin: checking /repo/.cloudpin.yml\n  ok kubernetes: active account matches the pin"],
  ["empty output", ""],
  ["an unknown result", JSON.stringify({ result: "weird" })],
  ["a result with no providers list", JSON.stringify({ result: "match" })],
  ["JSON that is not an object", "[]"],
  ["null", "null"],
  ["a provider entry that is not an object", JSON.stringify({ result: "mismatch", providers: [null] })],
]) {
  test(`fails closed on ${name}`, () => {
    const out = run(text);
    assert.equal(out.result, "error");
    assert.equal(out.exitCode, 1);
    assert.match(out.summary, /could not read cloudpin's result/);
    assert.equal(out.annotations.length, 1);
    assert.ok(out.annotations[0].startsWith("::error title=cloudpin::could not read cloudpin's result"));
  });
}

test("a passing result that lists a failing cloud fails closed", () => {
  const out = run({ ...MATCH, providers: [MISMATCH.providers[0]] });
  assert.equal(out.result, "error");
  assert.equal(out.exitCode, 1);
});

test("an unknown provider status inside a passing result fails closed", () => {
  const out = run({ ...MATCH, providers: [{ provider: "kubernetes", status: "maybe", problems: [] }] });
  assert.equal(out.result, "error");
  assert.equal(out.exitCode, 1);
});

test("not-installed is annotated only in strict (--only) mode", () => {
  const entry = { provider: "kubernetes", status: "not-installed", problems: ["kubectl is not installed here"] };
  const lax = run({ result: "match", path: PATH, environment: null, providers: [entry] });
  assert.equal(lax.exitCode, 0);
  assert.deepEqual(lax.annotations, []);
  const strict = run({ result: "mismatch", path: PATH, environment: null, only: ["kubernetes"], providers: [entry] });
  assert.equal(strict.exitCode, 1);
  assert.deepEqual(strict.annotations, ["::error title=cloudpin kubernetes::kubectl is not installed here"]);
});

test("not-logged-in and unknown are annotated with their fix", () => {
  const out = run({
    result: "error",
    path: PATH,
    environment: null,
    only: ["github", "azure"],
    providers: [
      { provider: "azure", status: "unknown", problems: ["boom"], fix: "az account show" },
      { provider: "github", status: "not-logged-in", problems: ["not logged in"], fix: "gh auth login --hostname github.com" },
    ],
  });
  assert.equal(out.exitCode, 1);
  assert.deepEqual(out.annotations, [
    "::error title=cloudpin azure::boom; fix: az account show",
    "::error title=cloudpin github::not logged in; fix: gh auth login --hostname github.com",
  ]);
});

test("a | and a newline in a problem are escaped in the table and the annotation", () => {
  const out = run({
    ...MISMATCH,
    providers: [{ provider: "kubernetes", status: "mismatch", problems: ["a | b\nc 100%\r"], fix: "x|y" }],
  });
  const row = out.summary.split("\n").find((line) => line.startsWith("| kubernetes "));
  assert.ok(row, out.summary);
  assert.match(row, /a \\\| b<br>c 100%/);
  assert.match(row, /fix: x\\\|y/);
  assert.equal(row.split(/(?<!\\)\|/).length, 5, row);
  assert.equal(out.annotations.length, 1);
  assert.equal(out.annotations[0], "::error title=cloudpin kubernetes::a | b%0Ac 100%25%0D; fix: x|y");
  assert.doesNotMatch(out.annotations[0], /\n/);
});

test("a Windows pin file path keeps its backslashes in Markdown", () => {
  const out = run({ ...MATCH, path: "D:\\a\\app\\.cloudpin.yml" });
  assert.match(out.summary, /D:\\\\a\\\\app\\\\\.cloudpin\.yml/);
});

test("the environment cloudpin chose is shown", () => {
  const out = run({ ...MATCH, environment: { name: "staging", protected: false, source: 'branch "dev" (CLOUDPIN_BRANCH)' } });
  assert.match(out.summary, /staging/);
  assert.match(out.summary, /CLOUDPIN_BRANCH/);
});

// The CLI entry: reads the report file, appends to the env files, exits.
const SCRIPT = fileURLToPath(new URL("../src/report.mjs", import.meta.url));

function cli(reportText, { withEnvFiles = true } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "cloudpin-action-test-"));
  try {
    const reportFile = join(dir, "report.json");
    if (reportText !== null) writeFileSync(reportFile, reportText);
    const summaryFile = join(dir, "summary.md");
    const outputFile = join(dir, "output.txt");
    writeFileSync(summaryFile, "earlier\n");
    writeFileSync(outputFile, "other=1\n");
    const env = { ...process.env };
    delete env.GITHUB_STEP_SUMMARY;
    delete env.GITHUB_OUTPUT;
    if (withEnvFiles) Object.assign(env, { GITHUB_STEP_SUMMARY: summaryFile, GITHUB_OUTPUT: outputFile });
    const res = spawnSync(process.execPath, [SCRIPT, reportFile], { env, encoding: "utf8" });
    return {
      status: res.status,
      stdout: res.stdout,
      summary: readFileSync(summaryFile, "utf8"),
      output: readFileSync(outputFile, "utf8"),
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("cli: match exits 0 and appends the summary and the output", () => {
  const out = cli(JSON.stringify(MATCH));
  assert.equal(out.status, 0);
  assert.equal(out.output, "other=1\nresult=match\n");
  assert.ok(out.summary.startsWith("earlier\n### cloudpin: all checked accounts match"), out.summary);
});

test("cli: mismatch exits 1 and prints the annotation", () => {
  const out = cli(JSON.stringify(MISMATCH));
  assert.equal(out.status, 1);
  assert.equal(out.output, "other=1\nresult=mismatch\n");
  assert.match(out.stdout, /^::error title=cloudpin kubernetes::server: expected/m);
});

test("cli: a missing report file exits 1 with result error", () => {
  const out = cli(null);
  assert.equal(out.status, 1);
  assert.equal(out.output, "other=1\nresult=error\n");
  assert.match(out.stdout, /could not read cloudpin's result/);
});

test("cli: runs without the GitHub env files", () => {
  const out = cli(JSON.stringify(UNPINNED), { withEnvFiles: false });
  assert.equal(out.status, 0);
  assert.equal(out.output, "other=1\n");
  assert.equal(out.summary, "earlier\n");
});

test("cli: no argument exits 1", () => {
  const env = { ...process.env };
  delete env.GITHUB_STEP_SUMMARY;
  delete env.GITHUB_OUTPUT;
  const res = spawnSync(process.execPath, [SCRIPT], { env, encoding: "utf8" });
  assert.equal(res.status, 1);
});
