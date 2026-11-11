/**
 * Unit tests for the pure resolution rules (design.md FR-2).
 * These import lib/resolve.js only, so they run outside the DSH app process:
 *   node --test
 */
import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { isExecutableFile, candidateBashPaths, resolveBashPath } from "../lib/resolve.js";

const NODE = process.execPath;

test("isExecutableFile: rejects empty, missing, and directories", () => {
  assert.equal(isExecutableFile(""), false);
  assert.equal(isExecutableFile(undefined), false);
  assert.equal(isExecutableFile("C:\\definitely-not-here\\bash.exe"), false);
  assert.equal(isExecutableFile(NODE.slice(0, NODE.lastIndexOf("\\"))), false);
});

test("isExecutableFile: accepts a real executable", () => {
  assert.equal(isExecutableFile(NODE), true);
});

test("declared-but-invalid throws GITBASH_UNAVAILABLE and never consults candidates", () => {
  // The candidate list contains a perfectly good executable; a declared invalid
  // path must still fail instead of silently falling back (negative assertion).
  assert.throws(
    () => resolveBashPath("C:\\nope\\bash.exe", [NODE]),
    (error) => error instanceof Error && error.message.includes("GITBASH_UNAVAILABLE"),
  );
});

test("declared-and-valid wins over every candidate", () => {
  assert.equal(resolveBashPath(NODE, ["C:\\other\\bash.exe"]), NODE);
});

test("empty declaration walks the candidate chain in order", () => {
  const ordered = ["C:\\missing\\bash.exe", NODE];
  assert.equal(resolveBashPath("", ordered), NODE);
  assert.equal(resolveBashPath("   ", ordered), NODE);
});

test("empty declaration with no usable candidate throws", () => {
  assert.throws(
    () => resolveBashPath("", ["C:\\missing\\bash.exe"]),
    (error) => error instanceof Error && error.message.includes("GITBASH_UNAVAILABLE"),
  );
});

test("candidateBashPaths: deterministic prefix order and de-duplication", () => {
  const saved = { ...process.env };
  try {
    process.env.DSH_GITBASH_PATH = "C:\\env\\bash.exe";
    process.env.DSH_GITBASH_ROOT = "C:\\root";
    process.env.GIT_INSTALL_ROOT = "C:\\root";
    delete process.env.ProgramW6432;
    delete process.env.ProgramFiles;
    delete process.env["ProgramFiles(x86)"];
    delete process.env.LOCALAPPDATA;
    const list = candidateBashPaths();
    assert.equal(list[0], "C:\\env\\bash.exe");
    assert.equal(list[1], "C:\\root\\bin\\bash.exe");
    // GIT_INSTALL_ROOT resolves to the same path as DSH_GITBASH_ROOT -> de-duped.
    assert.equal(list.filter((entry) => entry === "C:\\root\\bin\\bash.exe").length, 1);
  } finally {
    for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
    Object.assign(process.env, saved);
  }
});


test("candidateBashPaths: only documented sources (release hygiene)", () => {
  const saved = { ...process.env };
  try {
    process.env.DSH_GITBASH_PATH = "C:\\env\\bash.exe";
    process.env.DSH_GITBASH_ROOT = "C:\\root";
    process.env.GIT_INSTALL_ROOT = "C:\\root";
    delete process.env.ProgramW6432;
    delete process.env.ProgramFiles;
    delete process.env["ProgramFiles(x86)"];
    delete process.env.LOCALAPPDATA;
    const pathEntries = (process.env.PATH ?? process.env.Path ?? "")
      .split(";")
      .filter((entry) => entry.length > 0)
      .map((directory) => join(directory, "bash.exe"));
    const seen = new Set();
    const expected = [];
    for (const candidate of ["C:\\env\\bash.exe", "C:\\root\\bin\\bash.exe", ...pathEntries]) {
      const key = candidate.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      expected.push(candidate);
    }
    // A baked-in convenience path (the pre-release chain had two) would appear
    // here without coming from the environment or PATH.
    assert.deepEqual(candidateBashPaths(), expected);
  } finally {
    for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
    Object.assign(process.env, saved);
  }
});
