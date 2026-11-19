/**
 * Functional tests for the standalone bash tool. No DSH process needed:
 * lib/index.js imports only node builtins plus ./resolve.js, and the spawn
 * dependency is injected (a node:child_process adapter stands in for the host
 * subprocess service). The sandbox cases inject fake `ctx` services instead,
 * so they exercise the v0.2.0/v0.2.2 seam without a live DSH (T1–T18 and the
 * T2b/T3b/T7b/T12b/T17b variants) and resolve a fake bashPath (process.execPath).
 * Only the four real-call cases need Git Bash; they skip when the candidate
 * chain yields no verified Git Bash (a System32 WSL launcher never counts).
 *   node --test
 */
import test from "node:test";
import assert from "node:assert/strict";
import { spawn as nodeSpawn, spawnSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { runArgv, renderResult, apply } from "../lib/index.js";
import { isExecutableFile, candidateBashPaths } from "../lib/resolve.js";

/** A resolvable executable for every fake-ctx case: no real bash needed. */
const FAKE_BASH = process.execPath;

const SYSTEM32_PREFIX = (((process.env.SystemRoot ?? process.env.windir ?? "C:\\Windows") + "\\System32")).toLowerCase();

/** WSL's launcher lives in System32; it is not a Git Bash and must never fail a real-call case. */
function isSystemBash(candidate) {
  const lowered = candidate.toLowerCase();
  return lowered.startsWith(SYSTEM32_PREFIX + "\\") || lowered.includes("\\windows\\system32\\");
}

/** Prove a candidate is Git Bash: `uname -s` must report a MINGW/MSYS/CYGWIN kernel. */
function isGitBash(candidate) {
  try {
    const probe = spawnSync(candidate, ["--noprofile", "--norc", "-c", "uname -s"], {
      encoding: "utf8",
      timeout: 15000,
      windowsHide: true,
    });
    return probe.status === 0 && /MINGW|MSYS|CYGWIN/i.test(probe.stdout ?? "");
  } catch {
    return false;
  }
}

/**
 * Real Git Bash for the four real-call cases, or undefined. A candidate counts
 * only when it is an executable file outside System32 whose `uname -s` says
 * Git Bash, so a WSL `bash.exe` on PATH makes those cases skip instead of red.
 * Every other case in this file runs against FAKE_BASH and never needs bash.
 */
const BASH = (() => {
  let candidates;
  try {
    candidates = candidateBashPaths();
  } catch {
    return undefined;
  }
  for (const candidate of candidates) {
    if (isSystemBash(candidate)) continue;
    if (!isExecutableFile(candidate)) continue;
    if (!isGitBash(candidate)) continue;
    return candidate;
  }
  return undefined;
})();

const WORKSPACE = "C:\\workspace";
const ORIGINAL_ARGV = (command) => [FAKE_BASH, "--noprofile", "--norc", "-c", command];

/**
 * The first line MSYS prints when a restricted token denies `\BaseNamedObjects`
 * (DSH 0.2.2-rc.5 field evidence): bash.exe dies before running the command.
 */
const MSYS_RESTRICTED_STDERR =
  "bash.exe: *** fatal error - NtCreateDirectoryObject(\\BaseNamedObjects\\msys-2.0S5-abc): 0xC0000022\r\n";
const MSYS_RESTRICTED_EXIT = 3221225794;

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

/** A spawn stand-in that starts no process; records the spec it was handed. */
function cannedSpawn({ exitCode = 0, signal = null, stdout = "", stderr = "" } = {}) {
  return () => ({
    done: Promise.resolve(signal === null ? { exitCode } : { exitCode: null, signal }),
    collected: {
      stdout: { readFrom: () => ({ text: stdout, nextOffset: Buffer.byteLength(stdout), lossy: false }) },
      stderr: { readFrom: () => ({ text: stderr, nextOffset: Buffer.byteLength(stderr), lossy: false }) },
    },
  });
}

/** The default fake wrap: a runner argv plus no classification facts. */
function fakePrepared(argv) {
  return { argv: ["fake-runner.exe", "--", ...argv], enforcement: "partial", denialSignatures: [], runnerFailureRules: [] };
}

/**
 * Build a fake ctx with only the services the case wants, register the tool
 * through apply(), and return the definition plus every observed call.
 */
function harness({ policy, policyService = policy !== undefined, resolveError, withSandbox = true, confine, spawn, config = {} } = {}) {
  const services = new Map();
  const spawnSpecs = [];
  const confineCalls = [];
  const policyRequests = [];
  services.set("subprocess", {
    spawn: (spec) => {
      spawnSpecs.push(spec);
      return (spawn ?? cannedSpawn())(spec);
    },
  });
  if (policyService) {
    services.set("sandboxPolicy", {
      resolve: (request) => {
        policyRequests.push(request);
        if (resolveError !== undefined) throw resolveError;
        return policy;
      },
    });
  }
  if (withSandbox) {
    services.set("sandbox", {
      confine: async (argv, resolvedPolicy, signal) => {
        confineCalls.push({ argv, policy: resolvedPolicy, signal });
        return confine === undefined ? fakePrepared(argv) : confine(argv, resolvedPolicy, signal);
      },
    });
  }
  const registered = [];
  const ctx = {
    get: (service) => services.get(service),
    effect: (fn) => fn(),
    tools: { register: (definition) => registered.push(definition) },
  };
  apply(ctx, { bashPath: FAKE_BASH, ...config });
  return { definition: registered[0], spawnSpecs, confineCalls, policyRequests };
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

test("execute() refuses an empty command and a missing subprocess", async () => {
  const registered = [];
  const ctx = { get: () => undefined, effect: (fn) => fn(), tools: { register: (d) => registered.push(d) } };
  apply(ctx, { bashPath: FAKE_BASH });
  const definition = registered[0];
  assert.match(await definition.execute({ command: "  " }, {}), /non-empty/);
  assert.match(await definition.execute({ command: "echo hi" }, {}), /EXECUTOR_UNAVAILABLE/);
});

// ---------------------------------------------------------------------------
// v0.2.0 sandbox seam (docs/v0.2-design.md FR-S1..FR-S5, T1–T16)
// ---------------------------------------------------------------------------

test("T1 danger-full-access spawns the original argv and never asks the sandbox", async () => {
  const h = harness({
    policy: { mode: "danger-full-access", workspaceRoot: WORKSPACE },
    spawn: cannedSpawn({ stdout: "ok\n" }),
  });
  const text = await h.definition.execute({ command: "echo hi" }, {});
  assert.equal(h.confineCalls.length, 0);
  assert.equal(h.spawnSpecs.length, 1);
  assert.deepEqual(h.spawnSpecs[0].argv, ORIGINAL_ARGV("echo hi"));
  assert.match(text, /ok/);
});

test("T2 workspace-write confines the exact argv and spawns the prepared argv", async () => {
  const policy = { mode: "workspace-write", workspaceRoot: WORKSPACE };
  const prepared = { argv: ["runner.exe", "--workspace", WORKSPACE, "--", ...ORIGINAL_ARGV("echo hi")], enforcement: "partial", denialSignatures: [], runnerFailureRules: [] };
  const h = harness({ policy, confine: async () => prepared, spawn: cannedSpawn({ stdout: "ok\n" }) });
  const controller = new AbortController();
  const text = await h.definition.execute({ command: "echo hi" }, { signal: controller.signal });
  assert.equal(h.confineCalls.length, 1);
  assert.deepEqual(h.confineCalls[0].argv, ORIGINAL_ARGV("echo hi"));
  assert.deepEqual(h.confineCalls[0].policy, policy);
  assert.equal(h.confineCalls[0].signal, controller.signal);
  assert.equal(h.spawnSpecs.length, 1);
  assert.deepEqual(h.spawnSpecs[0].argv, prepared.argv);
  assert.match(text, /ok/);
});

test("T2b read-only is confined like any other mode and is not rejected as unsupported", async () => {
  const policy = { mode: "read-only", workspaceRoot: WORKSPACE };
  const prepared = { argv: ["runner.exe", "--mode", "read-only", "--", ...ORIGINAL_ARGV("echo hi")], enforcement: "partial", denialSignatures: [], runnerFailureRules: [] };
  const h = harness({ policy, confine: async () => prepared, spawn: cannedSpawn({ stdout: "ok\n" }) });
  const text = await h.definition.execute({ command: "echo hi" }, {});
  assert.equal(h.confineCalls.length, 1);
  assert.equal(h.confineCalls[0].policy.mode, "read-only");
  assert.deepEqual(h.spawnSpecs[0].argv, prepared.argv);
  assert.doesNotMatch(text, /SANDBOX_UNSUPPORTED_POLICY/);
});

test("T3 a missing policy service refuses to run unconfined by default", async () => {
  const h = harness({ withSandbox: false, spawn: cannedSpawn({}) });
  const text = await h.definition.execute({ command: "echo hi" }, {});
  assert.match(text, /^SANDBOX_UNAVAILABLE: the sandbox policy service is not composed/);
  assert.equal(h.spawnSpecs.length, 0);
  assert.equal(h.confineCalls.length, 0);
});

test("T3b a malformed policy (including null) fails closed even with the missing-service switch on", async () => {
  for (const policy of [null, undefined, { mode: "god-mode" }, "workspace-write", 42]) {
    const h = harness({
      policy,
      policyService: true,
      config: { unconfinedWhenSandboxMissing: true },
      spawn: cannedSpawn({}),
    });
    const text = await h.definition.execute({ command: "echo hi" }, {});
    assert.equal(text, "SANDBOX_UNAVAILABLE: malformed sandbox policy", "policy=" + JSON.stringify(policy));
    assert.equal(h.spawnSpecs.length, 0);
    assert.equal(h.confineCalls.length, 0);
  }
  // A composed service whose resolve() throws is the same fail-closed refusal.
  const throwing = harness({
    policyService: true,
    resolveError: new Error("policy exploded"),
    config: { unconfinedWhenSandboxMissing: true },
    spawn: cannedSpawn({}),
  });
  const text = await throwing.definition.execute({ command: "echo hi" }, {});
  assert.equal(text, "SANDBOX_UNAVAILABLE: policy exploded");
  assert.equal(throwing.spawnSpecs.length, 0);
});

test("T4 the explicit missing-service switch restores the v0.1.0 unconfined path", async () => {
  const h = harness({ withSandbox: false, config: { unconfinedWhenSandboxMissing: true }, spawn: cannedSpawn({ stdout: "ok\n" }) });
  const text = await h.definition.execute({ command: "echo hi" }, {});
  assert.equal(h.confineCalls.length, 0);
  assert.deepEqual(h.spawnSpecs[0].argv, ORIGINAL_ARGV("echo hi"));
  assert.match(text, /ok/);
});

test("T5 a missing sandbox provider refuses a confined mode even with the switch on", async () => {
  const h = harness({
    policy: { mode: "workspace-write", workspaceRoot: WORKSPACE },
    withSandbox: false,
    config: { unconfinedWhenSandboxMissing: true },
    spawn: cannedSpawn({}),
  });
  const text = await h.definition.execute({ command: "echo hi" }, {});
  assert.equal(text, "SANDBOX_UNAVAILABLE: sandbox provider service is not composed");
  assert.equal(h.spawnSpecs.length, 0);
});

test("T6 a confine rejection keeps its sandbox error code and a malformed wrap never spawns", async () => {
  const policy = { mode: "workspace-write", workspaceRoot: WORKSPACE };
  const unsupported = Object.assign(
    new Error("Windows ACL confinement does not support additional writable directories"),
    { code: "SANDBOX_UNSUPPORTED_POLICY" },
  );
  const rejected = harness({ policy, confine: async () => { throw unsupported; }, spawn: cannedSpawn({}) });
  const text = await rejected.definition.execute({ command: "echo hi" }, {});
  assert.ok(text.startsWith("SANDBOX_UNSUPPORTED_POLICY: "), text);
  assert.equal(rejected.spawnSpecs.length, 0);

  for (const malformed of [{}, { argv: [] }, { argv: [42] }, { argv: "runner.exe" }]) {
    const h = harness({ policy, confine: async () => malformed, spawn: cannedSpawn({}) });
    const out = await h.definition.execute({ command: "echo hi" }, {});
    assert.equal(out, "SANDBOX_UNAVAILABLE: sandbox returned no argv", "prepared=" + JSON.stringify(malformed));
    assert.equal(h.spawnSpecs.length, 0);
  }
});

test("T7 a denial signature appends the host marker before the exit code", async () => {
  const prepared = {
    argv: ["runner.exe", "--", ...ORIGINAL_ARGV("echo hi")],
    enforcement: "partial",
    denialSignatures: ["Access is denied"],
    runnerFailureRules: [],
  };
  const h = harness({
    policy: { mode: "workspace-write", workspaceRoot: WORKSPACE },
    confine: async () => prepared,
    spawn: cannedSpawn({ exitCode: 1, stderr: "bash: /c/Windows/x: ACCESS IS DENIED\r\n" }),
  });
  const text = await h.definition.execute({ command: "echo hi" }, {});
  assert.match(text, /\[sandbox: file access denied under workspace-write mode\]/);
  assert.doesNotMatch(text, /runner itself failed/);
  assert.ok(text.indexOf("[sandbox: file access denied") < text.indexOf("[exit code: 1]"), text);
});

test("T7b a read-only denial carries the read-only marker", async () => {
  const prepared = {
    argv: ["runner.exe", "--mode", "read-only", "--", ...ORIGINAL_ARGV("echo hi")],
    enforcement: "partial",
    // The host's windows-acl dialect also reports "permission denied"; keeping
    // both signatures here is what makes this fixture match the real wrap.
    denialSignatures: ["access is denied", "permission denied"],
    runnerFailureRules: [],
  };
  const h = harness({
    policy: { mode: "read-only", workspaceRoot: WORKSPACE },
    confine: async () => prepared,
    spawn: cannedSpawn({ exitCode: 5, stderr: "touch: cannot touch 'x': Permission denied (os error 5)\n" }),
  });
  const text = await h.definition.execute({ command: "echo hi" }, {});
  assert.match(text, /\[sandbox: file access denied under read-only mode\]/);
  assert.ok(text.indexOf("[sandbox: file access denied") < text.indexOf("[exit code: 5]"), text);
});

test("T8 a runner-failure rule outranks a denial signature; its marker coexists with the exit code", async () => {
  const prepared = {
    argv: ["runner.exe", "--", ...ORIGINAL_ARGV("echo hi")],
    enforcement: "partial",
    denialSignatures: ["access is denied"],
    runnerFailureRules: [{ allowedExitCodes: [127], fatalSignatures: ["windows-acl-run: "] }],
  };
  const h = harness({
    policy: { mode: "workspace-write", workspaceRoot: WORKSPACE },
    confine: async () => prepared,
    spawn: cannedSpawn({ exitCode: 127, stderr: "windows-acl-run: CreateRestrictedToken failed: Access is denied\n" }),
  });
  const text = await h.definition.execute({ command: "echo hi" }, {});
  assert.match(text, /\[sandbox: the sandbox runner itself failed under workspace-write mode — the command did not run; this is a sandbox problem, not a command failure\]/);
  assert.doesNotMatch(text, /file access denied/);
  // Documented trade-off (docs/v0.2-design.md FR-S3): unlike a host throw, the
  // runner marker does not suppress the command's own exit marker.
  assert.match(text, /\[exit code: 127\]/);
  assert.ok(text.indexOf("[sandbox: the sandbox runner itself failed") < text.indexOf("[exit code: 127]"), text);
});

test("T9 allowedExitCodes and informational lines never fake a runner failure", async () => {
  const prepared = {
    argv: ["runner.exe", "--", ...ORIGINAL_ARGV("echo hi")],
    enforcement: "partial",
    denialSignatures: [],
    runnerFailureRules: [{
      allowedExitCodes: [127],
      fatalSignatures: ["windows-acl-run: "],
      informationalLines: ["windows-acl-run: partial enforcement (older Landlock ABI)"],
    }],
  };
  const informational = harness({
    policy: { mode: "workspace-write", workspaceRoot: WORKSPACE },
    confine: async () => prepared,
    spawn: cannedSpawn({ exitCode: 127, stderr: "windows-acl-run: partial enforcement (older Landlock ABI)\n" }),
  });
  const quiet = await informational.definition.execute({ command: "echo hi" }, {});
  assert.doesNotMatch(quiet, /\[sandbox:/);
  assert.match(quiet, /\[exit code: 127\]/);

  const gated = harness({
    policy: { mode: "workspace-write", workspaceRoot: WORKSPACE },
    confine: async () => prepared,
    spawn: cannedSpawn({ exitCode: 1, stderr: "windows-acl-run: boom\n" }),
  });
  const outOfGate = await gated.definition.execute({ command: "echo hi" }, {});
  assert.doesNotMatch(outOfGate, /\[sandbox:/);
  assert.match(outOfGate, /\[exit code: 1\]/);
});

test("T10 a signal death is never classified as a denial", async () => {
  const prepared = {
    argv: ["runner.exe", "--", ...ORIGINAL_ARGV("echo hi")],
    enforcement: "partial",
    denialSignatures: ["permission denied"],
    runnerFailureRules: [],
  };
  const h = harness({
    policy: { mode: "workspace-write", workspaceRoot: WORKSPACE },
    confine: async () => prepared,
    spawn: cannedSpawn({ signal: "SIGTERM", stderr: "permission denied" }),
  });
  const text = await h.definition.execute({ command: "echo hi" }, {});
  assert.doesNotMatch(text, /\[sandbox:/);
  assert.match(text, /\[signal: SIGTERM\]/);
});

test("T11 lib has no @deepseek-ai value import and stays pure ESM", () => {
  const libDir = fileURLToPath(new URL("../lib/", import.meta.url));
  const files = readdirSync(libDir).filter((file) => file.endsWith(".js"));
  assert.ok(files.length > 0, "lib/ must contain at least one module");
  for (const file of files) {
    const source = readFileSync(new URL(file, new URL("../lib/", import.meta.url)), "utf8");
    assert.doesNotMatch(source, /from\s*["']@deepseek-ai/, file + ": value import");
    assert.doesNotMatch(source, /require\s*\(\s*["']@deepseek-ai/, file + ": require");
    assert.doesNotMatch(source, /\brequire\s*\(/, file + ": CommonJS require");
    assert.doesNotMatch(source, /module\.exports/, file + ": CommonJS export");
  }
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  assert.equal(pkg.type, "module");
});

test("T12b a call without an agent resolves the deployment policy and confines by that mode", async () => {
  const policy = { mode: "workspace-write", workspaceRoot: WORKSPACE };
  const withoutAgent = harness({ policy });
  await withoutAgent.definition.execute({ command: "echo hi" }, {});
  assert.deepEqual(withoutAgent.policyRequests, [{}]);
  assert.equal(withoutAgent.confineCalls.length, 1);
  assert.equal(withoutAgent.confineCalls[0].policy.mode, "workspace-write");

  const withAgent = harness({ policy: { mode: "danger-full-access", workspaceRoot: WORKSPACE } });
  const session = { id: "session-1" };
  await withAgent.definition.execute({ command: "echo hi" }, { agent: { session } });
  assert.deepEqual(withAgent.policyRequests, [{ session }]);
  assert.equal(withAgent.confineCalls.length, 0);
});

test("T13 load-ok.txt records the sandbox services diagnostic", () => {
  const loadOk = new URL("../load-ok.txt", import.meta.url);
  const register = (services) => {
    const ctx = {
      get: (service) => services.get(service),
      effect: (fn) => fn(),
      tools: { register: () => {} },
    };
    apply(ctx, {});
    return readFileSync(loadOk, "utf8");
  };
  const present = register(new Map([
    ["sandboxPolicy", { resolve: () => ({ mode: "danger-full-access", workspaceRoot: WORKSPACE }) }],
    ["sandbox", { confine: async () => ({ argv: ["runner.exe"] }) }],
  ]));
  assert.match(present, /tool=bash/);
  assert.match(present, /sandboxServicesAtApply=present/);
  const missing = register(new Map());
  assert.match(missing, /sandboxServicesAtApply=missing/);
});

test("T14 a confined runner that cannot start is SANDBOX_UNAVAILABLE, not a denial or a command failure", async () => {
  const policy = { mode: "workspace-write", workspaceRoot: WORKSPACE };
  const startupError = Object.assign(new Error("spawn fake-runner.exe ENOENT"), {
    code: "ENOENT",
    path: "C:\\fake\\runner.exe",
    syscall: "spawn fake-runner.exe",
  });
  const h = harness({
    policy,
    spawn: () => { throw startupError; },
  });
  const text = await h.definition.execute({ command: "echo hi" }, {});
  assert.ok(text.startsWith("SANDBOX_UNAVAILABLE: "), text);
  assert.match(text, /the sandbox runner could not be started/);
  assert.match(text, /the command did not run/);
  assert.match(text, /ENOENT/);
  assert.match(text, /C:\\fake\\runner\.exe/);
  assert.doesNotMatch(text, /\[sandbox:/);
  assert.doesNotMatch(text, /\[exit code:/);
  assert.equal(h.spawnSpecs.length, 1);
});

test("T15 a confine SANDBOX_PREPARATION_FAILED keeps its token and never spawns", async () => {
  const policy = { mode: "workspace-write", workspaceRoot: WORKSPACE };
  const preparationError = Object.assign(
    new Error("windows-acl-run: failed to prepare the private temp root"),
    { code: "SANDBOX_PREPARATION_FAILED" },
  );
  const h = harness({
    policy,
    confine: async () => { throw preparationError; },
    spawn: cannedSpawn({}),
  });
  const text = await h.definition.execute({ command: "echo hi" }, {});
  assert.ok(text.startsWith("SANDBOX_PREPARATION_FAILED: "), text);
  assert.match(text, /failed to prepare the private temp root/);
  assert.equal(h.confineCalls.length, 1);
  assert.equal(h.spawnSpecs.length, 0);
});

test("T16 a confine SANDBOX_INVALID_TEMP_ROOT keeps its token and never spawns", async () => {
  const policy = { mode: "workspace-write", workspaceRoot: WORKSPACE };
  const tempRootError = Object.assign(
    new Error("TEMP resolves inside the workspace root: C:\\workspace\\tmp"),
    { code: "SANDBOX_INVALID_TEMP_ROOT" },
  );
  const h = harness({
    policy,
    confine: async () => { throw tempRootError; },
    spawn: cannedSpawn({}),
  });
  const text = await h.definition.execute({ command: "echo hi" }, {});
  assert.ok(text.startsWith("SANDBOX_INVALID_TEMP_ROOT: "), text);
  assert.match(text, /TEMP resolves inside the workspace root/);
  assert.equal(h.confineCalls.length, 1);
  assert.equal(h.spawnSpecs.length, 0);
});

// ---------------------------------------------------------------------------
// v0.2.2 Windows restricted-token MSYS start failure (FR-E1, T17–T18)
// ---------------------------------------------------------------------------

test("T17 a restricted-mode MSYS start failure is explained and never rendered as a command exit", async () => {
  const h = harness({
    policy: { mode: "workspace-write", workspaceRoot: WORKSPACE },
    spawn: cannedSpawn({ exitCode: MSYS_RESTRICTED_EXIT, stderr: MSYS_RESTRICTED_STDERR }),
  });
  const text = await h.definition.execute({ command: "echo hi" }, {});
  assert.ok(text.startsWith("SANDBOX_UNAVAILABLE: "), text);
  assert.match(text, /Git Bash cannot start under the Windows restricted-token sandbox/);
  assert.match(text, /The command did not run/);
  assert.doesNotMatch(text, /\[exit code:/);
  assert.doesNotMatch(text, /\[sandbox:/);
  assert.equal(h.confineCalls.length, 1);
  assert.equal(h.spawnSpecs.length, 1);
});

test("T17b a restricted-mode exit without the MSYS signature keeps the original rendering", async () => {
  const h = harness({
    policy: { mode: "workspace-write", workspaceRoot: WORKSPACE },
    spawn: cannedSpawn({
      exitCode: MSYS_RESTRICTED_EXIT,
      stderr: "bash.exe: something unrelated went wrong\r\n",
    }),
  });
  const text = await h.definition.execute({ command: "echo hi" }, {});
  assert.doesNotMatch(text, /Git Bash cannot start under the Windows restricted-token sandbox/);
  assert.match(text, /\[stderr\]/);
  assert.match(text, /\[exit code: 3221225794\]/);
});

test("T18 danger-full-access and the policy-less unconfined path never trigger the MSYS text", async () => {
  const danger = harness({
    policy: { mode: "danger-full-access", workspaceRoot: WORKSPACE },
    spawn: cannedSpawn({ exitCode: MSYS_RESTRICTED_EXIT, stderr: MSYS_RESTRICTED_STDERR }),
  });
  const dangerText = await danger.definition.execute({ command: "echo hi" }, {});
  assert.doesNotMatch(dangerText, /Git Bash cannot start under the Windows restricted-token sandbox/);
  assert.match(dangerText, /\[exit code: 3221225794\]/);
  assert.equal(danger.confineCalls.length, 0);

  // policy === undefined (explicit missing-service switch): the guard must not
  // dereference policy.mode, and the original rendering stays unchanged.
  const unconfined = harness({
    withSandbox: false,
    config: { unconfinedWhenSandboxMissing: true },
    spawn: cannedSpawn({ exitCode: MSYS_RESTRICTED_EXIT, stderr: MSYS_RESTRICTED_STDERR }),
  });
  const unconfinedText = await unconfined.definition.execute({ command: "echo hi" }, {});
  assert.doesNotMatch(unconfinedText, /Git Bash cannot start under the Windows restricted-token sandbox/);
  assert.match(unconfinedText, /\[exit code: 3221225794\]/);
  assert.equal(unconfined.confineCalls.length, 0);
});
