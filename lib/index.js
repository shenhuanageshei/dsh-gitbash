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
 * No @deepseek-ai/* value import: the definition is a plain object registered
 * through ctx.tools.register, and the one host service it needs is read with
 * ctx.get('subprocess').
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
export function renderResult(value) {
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
  const markers = [];
  if (value.timedOut === true) markers.push("[timed out after " + value.timeoutMs + "ms]");
  if (value.error !== undefined) markers.push("[error: " + value.error + "]");
  if (value.signal !== undefined) markers.push("[signal: " + value.signal + "]");
  if (value.exitCode !== undefined && value.exitCode !== 0) markers.push("[exit code: " + value.exitCode + "]");
  return [body, ...markers].join("\n");
}

function clampTimeout(requested, config) {
  const fallback = config.timeoutMs;
  const cap = config.maxTimeoutMs;
  const value = typeof requested === "number" && Number.isFinite(requested) && requested > 0 ? requested : fallback;
  return Math.min(value, cap);
}

/**
 * Run one prepared argv through a spawn-like function.
 * \`spawn\` matches the host subprocess service's single method so tests can pass
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
      error: error instanceof Error ? error.message : String(error),
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
    "Output is bounded; large output spills to a file whose path is reported."
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
      const cwd = typeof args?.workdir === "string" && args.workdir.length > 0 ? args.workdir : exec?.cwd ?? process.cwd();
      const timeoutMs = clampTimeout(args?.timeoutMs, config);
      const value = await runArgv({
        spawn: (spec) => subprocess.spawn(spec),
        argv: [bash, "--noprofile", "--norc", "-c", command],
        cwd,
        timeoutMs,
        graceMs: config.graceMs,
        maxOutputBytes: config.maxOutputBytes,
        maxSpillBytes: config.maxSpillBytes,
        env: { ...process.env, ...ENV_OVERRIDES },
        signal: exec?.signal,
      });
      return renderResult(value);
    },
  };
  try {
    ctx.effect(() => ctx.tools.register(definition), "gitbash: bash tool");
    breadcrumb(LOAD_OK, "loaded=" + new Date().toISOString() + " tool=" + definition.name + " bashPath=" + config.bashPath);
  } catch (error) {
    breadcrumb(LOAD_ERROR, String(error?.stack ?? error));
    throw error;
  }
}