/**
 * Functional tests for the standalone bash tool. No DSH process needed:
 * lib/index.js imports only node builtins plus ./resolve.js, and the spawn
 * dependency is injected (a node:child_process adapter stands in for the host
 * subprocess service).
 *   node --test
 */
import test from "node:test";
import assert from "node:assert/strict";
import { spawn as nodeSpawn } from "node:child_process";
import { runArgv, renderResult, apply } from "../lib/index.js";
import { resolveBashPath, candidateBashPaths } from "../lib/resolve.js";

const BASH = (() => {
  try { return resolveBashPath("", candidateBashPaths()); } catch { return undefined; }
})();

/** Emulate the host subprocess contract over node:child_process. */
function adapter(spec) {
  const child = nodeSpawn(spec.argv[0], spec.argv.slice(1), { cwd: spec.cwd, env: spec.env, windowsHide: true });
  let out = "";
  let err = "";
  child.stdout.on("data", (chunk) => { out += chunk.toString(); });
  child.stderr.on("data", (chunk) => { err += chunk.toString(); });
  // Kill the whole tree on abort: the host's subprocess service contains the
  // process in a Windows Job, while a bare child.kill() would leave an orphaned
  // `sleep` holding the stdout pipe open and make the run look hung.
  spec.signal?.addEventListener?.("abort", () => {
    try { nodeSpawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true }); } catch { child.kill(); }
  });
  const done = new Promise((resolve) => child.on("close", (exitCode, signal) => resolve({ exitCode, signal })));
  return {
    done,
    collected: {
      stdout: { readFrom: () => ({ text: out, nextOffset: Buffer.byteLength(out), lossy: false }) },
      stderr: { readFrom: () => ({ text: err, nextOffset: Buffer.byteLength(err), lossy: false }) },
    },
  };
}

function run(command, overrides = {}) {
  return runArgv({
    spawn: adapter,
    argv: [BASH, "--noprofile", "--norc", "-c", command],
    cwd: process.cwd(),
    timeoutMs: 20000,
    graceMs: 1000,
    maxOutputBytes: 64000,
    maxSpillBytes: 1024 * 1024,
    env: { ...process.env, NO_COLOR: "1", TERM: "dumb" },
    signal: undefined,
    ...overrides,
  });
}

test("a real Git Bash invocation works and reports success", { skip: BASH === undefined }, async () => {
  const value = await run("uname -s");
  const text = renderResult(value);
  assert.match(text, /MINGW64_NT|MSYS_NT/);
  assert.equal(value.exitCode, 0);
  assert.doesNotMatch(text, /\[exit code:/);
});

test("a non-zero exit is reported, not thrown", { skip: BASH === undefined }, async () => {
  const value = await run("exit 3");
  assert.equal(value.exitCode, 3);
  assert.match(renderResult(value), /\[exit code: 3\]/);
});

test("stderr is merged under a marked section", { skip: BASH === undefined }, async () => {
  const value = await run("echo out; echo err 1>&2");
  const text = renderResult(value);
  assert.match(text, /out/);
  assert.match(text, /\[stderr\]/);
  assert.match(text, /err/);
});

test("a timeout is reported and the process is killed", { skip: BASH === undefined }, async () => {
  const started = Date.now();
  const value = await run("sleep 5", { timeoutMs: 800 });
  const elapsed = Date.now() - started;
  assert.equal(value.timedOut, true);
  assert.match(renderResult(value), /\[timed out after 800ms\]/);
  assert.ok(elapsed < 15000, "timeout must not wait for the full sleep");
});

test("apply() registers one string-output tool named bash", () => {
  const registered = [];
  const ctx = {
    get: () => undefined,
    effect: (fn) => fn(),
    tools: { register: (definition) => { registered.push(definition); } },
  };
  apply(ctx, { bashPath: "C:\\definitely-not-here\\bash.exe" });
  assert.equal(registered.length, 1);
  const definition = registered[0];
  assert.equal(definition.name, "bash");
  assert.equal(definition.output.schema.type, "string");
  assert.equal(typeof definition.execute, "function");
});

test("execute() refuses an empty command and a missing subprocess", { skip: BASH === undefined }, async () => {
  const registered = [];
  const ctx = { get: () => undefined, effect: (fn) => fn(), tools: { register: (d) => registered.push(d) } };
  apply(ctx, {});
  const definition = registered[0];
  assert.match(await definition.execute({ command: "  " }, {}), /non-empty/);
  assert.match(await definition.execute({ command: "echo hi" }, {}), /EXECUTOR_UNAVAILABLE/);
});