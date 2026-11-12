/**
 * dsh-gitbash — a standalone Bash tool for DeepSeek Harness that runs the local
 * Git for Windows bash.exe.
 *
 * ARCHITECTURE (rewritten 2026-11-11 after the first attempt failed in the field):
 * this plugin does NOT register ctx.shell. The shell seam has exactly one
 * implementation per context, the Windows preset stack requires that
 * implementation to be pwsh (disabling pwsh-sandbox breaks preset assembly with
 * UnknownPresetError), and a second registration throws. So the plugin adds a
 * *parallel* tool instead: it spawns the configured bash.exe through the host
 * subprocess service and leaves pwsh untouched.
 *
 * SANDBOX (v0.2.0, design: docs/v0.2-design.md): every call resolves the host
 * sandbox policy through ctx.sandboxPolicy and, unless the resolved mode is
 * danger-full-access, wraps the exact bash argv through ctx.sandbox.confine()
 * before anything is spawned. A blocked file effect and a broken runner are
 * reported with the host's own marker lines, and every sandbox failure is fail
 * closed — the only exception is the explicit unconfinedWhenSandboxMissing
 * switch for a profile that composes no policy service at all.
 *
 * No @deepseek-ai/* value import: the definition is a plain object registered
 * through ctx.tools.register, and the host services it needs are read with
 * ctx.get(...).
 */
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { candidateBashPaths, isExecutableFile, resolveBashPath } from "./resolve.js";

export { candidateBashPaths, isExecutableFile, resolveBashPath } from "./resolve.js";

export const name = "gitbash";

/**
 * The plugin needs the tools registry. Cordis only exposes injected services on
 * ctx; without this declaration `ctx.tools` is unreachable and apply() throws
 * (team-link declares the same for the same reason).
 */
export const inject = ["tools"];

const DEFAULTS = Object.freeze({
  timeoutMs: 120000,
  maxTimeoutMs: 600000,
  maxOutputBytes: 64000,
  maxSpillBytes: 64 * 1024 * 1024,
  graceMs: 3000,
});

/** Model-friendly environment overrides (mirrors the stock bash executor). */
const ENV_OVERRIDES = Object.freeze({
  NO_COLOR: "1",
  TERM: "dumb",
  PAGER: "cat",
  GIT_PAGER: "cat",
});

/** The closed sandbox-mode vocabulary the host policy service resolves to. */
const SANDBOX_MODE_SET = new Set(["read-only", "workspace-write", "danger-full-access"]);

/**
 * Error codes the sandbox seam publishes (dsh-sandbox / dsh-sandbox-local).
 * Any other thrown error maps to SANDBOX_UNAVAILABLE, so an unexpected shape
 * from a future host still fails closed with a recognizable first token.
 */
const SANDBOX_ERROR_CODES = new Set(["SANDBOX_UNAVAILABLE", "SANDBOX_UNSUPPORTED_POLICY", "SANDBOX_INVALID_ROOT"]);

/** Refusal text for a profile that composes no sandbox policy service. */
const POLICY_MISSING_TEXT = "the sandbox policy service is not composed in this profile; refusing to run unconfined.";

/** Read the retained stream after settlement, preserving truncation facts. */
export function settledStream(reader) {
  const read = reader?.readFrom?.(0);
  const text = typeof read?.text === "string" ? read.text : "";
  return {
    text,
    truncated: read?.lossy === true,
    ...(read?.spillPath !== undefined ? { spillPath: read.spillPath } : {}),
  };
}

/** Render one settled run the way the host shell tools do. */
export function renderResult(value, sandboxMarkers = []) {
  const stream = (output) =>
    output.truncated ? output.text + "\n[output truncated; full output: " + (output.spillPath ?? "(unavailable)") + "]" : output.text;
  const out = stream(value.stdout);
  const err = stream(value.stderr);
  let body = out;
  if (err.length > 0) {
    if (body.length > 0 && !body.endsWith("\n")) body += "\n";
    body += "[stderr]\n" + err;
  }
  if (body.length === 0) body = "(no output)";
  // Sandbox markers come first, exactly like the host's renderResult: the
  // sandbox fact outranks the command's own exit status.
  const markers = Array.isArray(sandboxMarkers) ? [...sandboxMarkers] : [];
  if (value.timedOut === true) markers.push("[timed out after " + value.timeoutMs + "ms]");
  if (value.error !== undefined) markers.push("[error: " + value.error + "]");
  if (value.signal !== undefined) markers.push("[signal: " + value.signal + "]");
  if (value.exitCode !== undefined && value.exitCode !== 0) markers.push("[exit code: " + value.exitCode + "]");
  return [body, ...markers].join("\n");
}

/** Read one optional host service without assuming ctx.get never throws. */
function safeGet(ctx, service) {
  try {
    return ctx.get(service);
  } catch {
    return undefined;
  }
}

/**
 * Map a sandbox failure onto the host's `<code>: <message>` shape. A known
 * sandbox error code wins; anything else is reported as SANDBOX_UNAVAILABLE.
 */
export function sandboxErrorText(detail, error) {
  const code = typeof error?.code === "string" && SANDBOX_ERROR_CODES.has(error.code) ? error.code : "SANDBOX_UNAVAILABLE";
  const message = error === undefined ? String(detail) : error instanceof Error ? error.message : String(error);
  return code + ": " + message;
}

/** The host's denial marker, verbatim (dsh-sandbox sandboxDenialMarker). */
export function sandboxDenialMarker(mode) {
  return "[sandbox: file access denied under " + mode + " mode]";
}

/** The host's runner-failure marker, verbatim (dsh-tool-bash sandboxNotes). */
export function sandboxRunnerFailureMarker(mode) {
  return "[sandbox: the sandbox runner itself failed under " + mode + " mode — the command did not run; this is a sandbox problem, not a command failure]";
}

/**
 * Explain a confined runner that never started at all (US-5): the executable
 * could not be spawned (ENOENT/EACCES/...). This is a sandbox problem, so the
 * caller reports SANDBOX_UNAVAILABLE and appends no denial marker; the spawn
 * error's code/path/syscall are kept so the refusal names the real cause.
 */
export function sandboxRunnerStartText(value) {
  const detail = [value?.errorCode, value?.errorSyscall, value?.errorPath]
    .filter((part) => typeof part === "string" && part.length > 0)
    .join(" ");
  const reason = typeof value?.error === "string" && value.error.length > 0 ? value.error : "unknown error";
  return (
    "the sandbox runner could not be started; the command did not run" +
    (detail.length > 0 ? " (" + detail + ")" : "") +
    ": " +
    reason
  );
}

/** Keep only string entries of a list read from the host's confine() result. */
function stringList(value) {
  return Array.isArray(value) ? value.filter((entry) => typeof entry === "string") : [];
}

/**
 * Classify one settled process against the wrap's structured runner-failure
 * rules — the host's classifyRunnerFailure: a nonzero numeric exit, the rule's
 * optional exact exit-code gate, and a fatal signature on one stderr line after
 * exact informational lines are excluded.
 * @returns the first matching fatal line, or undefined.
 */
export function classifyRunnerFailure(exitCode, stderr, rules) {
  if (typeof exitCode !== "number" || !Number.isFinite(exitCode) || exitCode === 0) return undefined;
  const lines = String(stderr ?? "").split(/\r?\n/);
  for (const rule of Array.isArray(rules) ? rules : []) {
    if (rule === null || typeof rule !== "object") continue;
    if (rule.allowedExitCodes !== undefined && !(Array.isArray(rule.allowedExitCodes) && rule.allowedExitCodes.includes(exitCode))) continue;
    const informational = new Set(stringList(rule.informationalLines).map((line) => line.toLowerCase()));
    const fatal = stringList(rule.fatalSignatures)
      .filter((signature) => signature.trim().length > 0)
      .map((signature) => signature.toLowerCase());
    if (fatal.length === 0) continue;
    for (const line of lines) {
      const lowered = line.toLowerCase();
      if (informational.has(lowered)) continue;
      if (fatal.some((signature) => lowered.includes(signature))) return line;
    }
  }
  return undefined;
}

/**
 * The sandbox markers one confined run earns, in render order.
 *
 * Runner failure outranks denial, matching the host: a broken runner means the
 * command never ran, so it can never be reported as a policy denial of that
 * command (a runner diagnostic may itself contain a denial signature).
 */
export function classifySandbox(result, mode, prepared) {
  const exitCode = result?.exitCode;
  if (typeof exitCode !== "number" || !Number.isFinite(exitCode) || exitCode === 0) return [];
  const stderr = result?.stderr?.text ?? "";
  if (classifyRunnerFailure(exitCode, stderr, prepared?.runnerFailureRules) !== undefined) {
    return [sandboxRunnerFailureMarker(mode)];
  }
  const lowered = String(stderr).toLowerCase();
  const denied = stringList(prepared?.denialSignatures).some((signature) => lowered.includes(signature.toLowerCase()));
  return denied ? [sandboxDenialMarker(mode)] : [];
}

function clampTimeout(requested, config) {
  const fallback = config.timeoutMs;
  const cap = config.maxTimeoutMs;
  const value = typeof requested === "number" && Number.isFinite(requested) && requested > 0 ? requested : fallback;
  return Math.min(value, cap);
}

/**
 * Run one prepared argv through a spawn-like function.
 * `spawn` matches the host subprocess service's single method so tests can pass
 * a node:child_process adapter.
 */
export async function runArgv({ spawn, argv, cwd, timeoutMs, graceMs, maxOutputBytes, maxSpillBytes, env, signal }) {
  const controller = new AbortController();
  const onAbort = () => controller.abort(signal?.reason);
  if (signal?.aborted) onAbort();
  else signal?.addEventListener?.("abort", onAbort, { once: true });
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort(new Error("command timed out after " + timeoutMs + "ms"));
  }, timeoutMs);
  timer.unref?.();
  let handle;
  // A synchronous throw from spawn() means the executable never started; that
  // is a sandbox failure for a confined run, not the command's own failure.
  let started = false;
  try {
    handle = spawn({
      argv,
      cwd,
      stdio: {
        stdin: { data: "" },
        stdout: { maxBytes: maxOutputBytes, spill: { maxBytes: maxSpillBytes } },
        stderr: { maxBytes: maxOutputBytes, spill: { maxBytes: maxSpillBytes } },
      },
      graceMs,
      signal: controller.signal,
      env,
    });
    started = true;
    const outcome = await handle.done;
    return {
      ...(outcome?.exitCode != null ? { exitCode: outcome.exitCode } : {}),
      ...(outcome?.signal != null ? { signal: outcome.signal } : {}),
      ...(timedOut ? { timedOut: true, timeoutMs } : {}),
      stdout: settledStream(handle.collected?.stdout),
      stderr: settledStream(handle.collected?.stderr),
    };
  } catch (error) {
    return {
      ...(started ? {} : { spawnFailure: true }),
      error: error instanceof Error ? error.message : String(error),
      ...(typeof error?.code === "string" ? { errorCode: error.code } : {}),
      ...(typeof error?.path === "string" ? { errorPath: error.path } : {}),
      ...(typeof error?.syscall === "string" ? { errorSyscall: error.syscall } : {}),
      ...(timedOut ? { timedOut: true, timeoutMs } : {}),
      stdout: settledStream(handle?.collected?.stdout),
      stderr: settledStream(handle?.collected?.stderr),
    };
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener?.("abort", onAbort);
  }
}

/** Describe the tool to the model. */
export function bashToolDescription() {
  return (
    "Run commands in the local Git for Windows Bash (the configured bash.exe is spawned directly; nothing is copied or unpacked). " +
    "Each call is a fresh non-login shell (--noprofile --norc). Pass workdir to choose the directory. " +
    "Use it for git, pipelines, and Unix tooling; use the dedicated file tools for file edits. " +
    "Foreground only: a server or watcher occupies the call until timeoutMs. " +
    "Output is bounded; large output spills to a file whose path is reported. " +
    "Commands may run under a file sandbox; a blocked file operation is reported as `[sandbox: file access denied under <mode> mode]`, a policy denial: do not retry another way."
  );
}

/** Fall back to the default for anything that is not a positive finite number. */
function positiveFinite(value, fallback) {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback;
}

/** Normalize the patch-row config once (design.md: config values must be positive finite). */
export function normalizeConfig(rawConfig) {
  const raw = rawConfig ?? {};
  return {
    bashPath: typeof raw.bashPath === "string" ? raw.bashPath : "",
    timeoutMs: positiveFinite(raw.timeoutMs, DEFAULTS.timeoutMs),
    maxTimeoutMs: positiveFinite(raw.maxTimeoutMs, DEFAULTS.maxTimeoutMs),
    maxOutputBytes: positiveFinite(raw.maxOutputBytes, DEFAULTS.maxOutputBytes),
    maxSpillBytes: positiveFinite(raw.maxSpillBytes, DEFAULTS.maxSpillBytes),
    graceMs: positiveFinite(raw.graceMs, DEFAULTS.graceMs),
    // The one escape hatch from the fail-closed default: a profile that
    // composes no sandbox policy service at all may explicitly accept
    // unconfined execution. Anything non-true is off.
    unconfinedWhenSandboxMissing: raw.unconfinedWhenSandboxMissing === true,
  };
}

const LOAD_OK = new URL("../load-ok.txt", import.meta.url);
const LOAD_ERROR = new URL("../load-error.txt", import.meta.url);

/** Best-effort diagnostic breadcrumb; never let it change the plugin outcome. */
function breadcrumb(target, text) {
  try {
    writeFileSync(fileURLToPath(target), text + "\n");
  } catch {
    /* diagnostics must never fail the plugin */
  }
}

export function apply(ctx, rawConfig) {
  const config = normalizeConfig(rawConfig);
  // Load-time diagnostic only (T13): which sandbox services this composition
  // resolved. It never changes the plugin outcome; execute() re-reads both.
  const sandboxServices =
    safeGet(ctx, "sandboxPolicy") !== undefined && safeGet(ctx, "sandbox") !== undefined ? "present" : "missing";
  const definition = {
    name: "bash",
    description: bashToolDescription(),
    // Host-side hard limit: must not cut a per-call override the parameter
    // description promises (min(request, maxTimeoutMs) + grace).
    timeoutMs: config.maxTimeoutMs + config.graceMs + 1000,
    parameters: {
      type: "object",
      properties: {
        command: { type: "string", description: "Bash command or pipeline to run." },
        description: { type: "string", description: "Short human-readable description of the command; accepted for compatibility." },
        workdir: { type: "string", description: "Working directory; defaults to the session workspace." },
        timeoutMs: { type: "number", description: "Per-call timeout in milliseconds (capped by maxTimeoutMs)." },
      },
    },
    output: {
      schema: { type: "string" },
      render: (_args, value) => [{ type: "text", text: String(value) }],
    },
    async execute(args, exec) {
      const command = typeof args?.command === "string" ? args.command : "";
      if (command.trim().length === 0) return "bash: command must be a non-empty string";
      let bash;
      try {
        bash = resolveBashPath(config.bashPath, candidateBashPaths());
      } catch (error) {
        return error instanceof Error ? error.message : String(error);
      }
      // ctx.get may return undefined OR throw for an unregistered service; both
      // are the same fact for the caller, so close the contract without
      // assuming the container's semantics.
      let subprocess;
      try {
        subprocess = ctx.get("subprocess");
      } catch {
        subprocess = undefined;
      }
      if (!subprocess?.spawn) return "EXECUTOR_UNAVAILABLE: the host subprocess service is unavailable; no command executed.";

      // FR-S1: resolve the policy for this one call. The request shape mirrors
      // the host tool-bash resolveSandboxPolicy: a tool call carries its agent,
      // while a call without one falls back to the deployment policy.
      const policyService = safeGet(ctx, "sandboxPolicy");
      let policy;
      if (policyService !== undefined) {
        try {
          policy = policyService?.resolve(exec?.agent ? { session: exec.agent.session } : {});
        } catch (error) {
          return sandboxErrorText(undefined, error);
        }
        // A composed policy service that hands back no usable policy is a
        // broken composition, never a license to run unconfined — the
        // missing-service switch deliberately does not cover it. `policy ===
        // null` is spelled out because typeof null is "object".
        if (policy === null || typeof policy !== "object" || !SANDBOX_MODE_SET.has(policy.mode)) {
          return sandboxErrorText("malformed sandbox policy");
        }
      }

      const cwd = typeof args?.workdir === "string" && args.workdir.length > 0 ? args.workdir : exec?.cwd ?? process.cwd();
      const timeoutMs = clampTimeout(args?.timeoutMs, config);

      // FR-S2: anything below danger-full-access runs through the host's
      // confinement seam; a missing provider is a refusal, not a fallback.
      let prepared;
      if (policy !== undefined && policy.mode !== "danger-full-access") {
        const sandbox = safeGet(ctx, "sandbox");
        if (sandbox === undefined || sandbox === null) return sandboxErrorText("sandbox provider service is not composed");
        try {
          prepared = await sandbox.confine([bash, "--noprofile", "--norc", "-c", command], policy, exec?.signal);
        } catch (error) {
          // Fail closed before any spawn; a sandbox error code keeps its token.
          return sandboxErrorText(undefined, error);
        }
        if (!Array.isArray(prepared?.argv) || prepared.argv.length === 0 || typeof prepared.argv[0] !== "string") {
          return sandboxErrorText("sandbox returned no argv");
        }
      } else if (policy === undefined && !config.unconfinedWhenSandboxMissing) {
        return sandboxErrorText(POLICY_MISSING_TEXT);
      }

      const argv = prepared !== undefined ? prepared.argv : [bash, "--noprofile", "--norc", "-c", command];
      const value = await runArgv({
        spawn: (spec) => subprocess.spawn(spec),
        argv,
        cwd,
        timeoutMs,
        graceMs: config.graceMs,
        maxOutputBytes: config.maxOutputBytes,
        maxSpillBytes: config.maxSpillBytes,
        env: { ...process.env, ...ENV_OVERRIDES },
        signal: exec?.signal,
      });
      // US-5: a confined runner that never started is a sandbox failure. Say so
      // with the SANDBOX_UNAVAILABLE token, state that the command did not run,
      // and append no denial marker. danger-full-access keeps its old path (the
      // marker form below), exactly like v0.1.0.
      if (prepared !== undefined && value.spawnFailure === true) {
        return sandboxErrorText(sandboxRunnerStartText(value));
      }
      const sandboxMarkers = prepared === undefined ? [] : classifySandbox(value, policy.mode, prepared);
      return renderResult(value, sandboxMarkers);
    },
  };
  try {
    ctx.effect(() => ctx.tools.register(definition), "gitbash: bash tool");
    breadcrumb(
      LOAD_OK,
      "loaded=" + new Date().toISOString() + " tool=" + definition.name + " bashPath=" + config.bashPath + " sandboxServices=" + sandboxServices,
    );
  } catch (error) {
    breadcrumb(LOAD_ERROR, String(error?.stack ?? error));
    throw error;
  }
}
