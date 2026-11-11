/**
 * Pure path-resolution core (design.md FR-2).
 *
 * Kept free of @deepseek-ai imports so it can be unit-tested outside the DSH
 * app process: node --test
 */
import { accessSync, constants, statSync } from "node:fs";
import { join } from "node:path";

const BASH_BASENAME = "bash.exe";

/** True when path names an existing executable file. */
export function isExecutableFile(candidate) {
  if (typeof candidate !== "string" || candidate.length === 0) return false;
  try {
    if (!statSync(candidate).isFile()) return false;
    accessSync(candidate, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** PATH directories of the harness process, in order. */
function pathDirectories() {
  const raw = process.env.PATH ?? process.env.Path ?? "";
  return raw.split(";").filter((entry) => entry.length > 0);
}

/**
 * Ordered discovery candidates. Order is contractual: the first executable
 * wins, and the unit tests pin it.
 */
export function candidateBashPaths() {
  const seen = new Set();
  const ordered = [];
  const push = (candidate) => {
    if (typeof candidate !== "string" || candidate.length === 0) return;
    const key = candidate.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    ordered.push(candidate);
  };
  const env = process.env;
  push(env.DSH_GITBASH_PATH);
  if (env.DSH_GITBASH_ROOT) push(join(env.DSH_GITBASH_ROOT, "bin", BASH_BASENAME));
  if (env.GIT_INSTALL_ROOT) push(join(env.GIT_INSTALL_ROOT, "bin", BASH_BASENAME));
  for (const root of [env.ProgramW6432, env.ProgramFiles, env["ProgramFiles(x86)"]]) {
    if (root) push(join(root, "Git", "bin", BASH_BASENAME));
  }
  if (env.LOCALAPPDATA) push(join(env.LOCALAPPDATA, "Programs", "Git", "bin", BASH_BASENAME));
  for (const directory of pathDirectories()) push(join(directory, BASH_BASENAME));
  return ordered;
}

/** Reason text shared by every failure to resolve the executable. */
export function unavailable(detail) {
  return new Error(
    "GITBASH_UNAVAILABLE: " +
      detail +
      ". Set the executor's bashPath config to your Git for Windows bin\\bash.exe " +
      "(for example C:\\Program Files\\Git\\bin\\bash.exe), or point DSH_GITBASH_PATH / " +
      "DSH_GITBASH_ROOT at it. This is a configuration problem, not a sandbox denial; " +
      "do not switch the DSH permission mode or bypass confinement.",
  );
}

/**
 * Resolve the executable honouring FR-2: a declared path is the ONLY candidate
 * (invalid => throw, never fall back); an empty declaration walks the chain.
 */
export function resolveBashPath(declaredRaw, candidates = candidateBashPaths()) {
  const declared = String(declaredRaw ?? "").trim();
  if (declared.length > 0) {
    if (!isExecutableFile(declared)) throw unavailable("bashPath " + JSON.stringify(declared) + " is not an executable file");
    return declared;
  }
  const found = candidates.find((candidate) => isExecutableFile(candidate));
  if (found === undefined) {
    throw unavailable(
      "no " + BASH_BASENAME + " was found in DSH_GITBASH_PATH, DSH_GITBASH_ROOT, GIT_INSTALL_ROOT, " +
        "the conventional Git install roots, or PATH",
    );
  }
  return found;
}

