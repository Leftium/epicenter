// Doc-hygiene check. Deterministic, fixable-in-loop, CI-optional.
//
// Two smells, by design only the second needs detecting:
//
//   1. A spec in the tree that declares a TERMINAL status (Implemented,
//      Superseded, Done, Retrospective, ...). Under the current model a spec is
//      in-flight only (Draft | In Progress); "done" is deletion. A terminal
//      status means the spec should have been harvested into docs/adr/ and
//      deleted. (Smell #1 is mostly designed out by the two-state enum; this
//      catches stragglers and regressions.) The whole file is scanned, not just
//      the header: this corpus routinely declares "**Status**: Implemented" as a
//      trailing line, so a head-only window would miss the real stragglers.
//
//   2. A Proposed ADR that no in-tree spec references. That means its spec was
//      deleted, i.e. the work landed, so the ADR should be Accepted (or, if the
//      work was abandoned, superseded). This is a structural signal, not a
//      heuristic. Age is a secondary, softer signal.
//
// Exit non-zero if anything is flagged so a review step or CI can gate on it.
// Run from repo root: bun scripts/check-doc-hygiene.mjs
import { execSync } from "node:child_process";
import { readFileSync, readdirSync, existsSync } from "node:fs";

const STALE_DAYS = 21;
const TODAY = new Date();

function tracked(glob) {
  return execSync(`git ls-files ${glob}`, { encoding: "utf8" })
    .split("\n").map((s) => s.trim()).filter(Boolean);
}
function head(path, n = 15) {
  try { return readFileSync(path, "utf8").split("\n").slice(0, n).join("\n"); }
  catch { return ""; }
}
function whole(path) {
  try { return readFileSync(path, "utf8"); }
  catch { return ""; }
}
// A spec's own status, minus fenced code blocks. Example data (a YAML fixture
// with `status: completed`, a TS field `status: string`) lives inside fences and
// must not be read as the spec's declared status.
function specProse(path) {
  return whole(path).replace(/```[\s\S]*?```/g, "");
}

const flags = [];

// --- Smell 1: terminal-status specs still in the tree ----------------------
// The status VALUE must START with a terminal word (after optional ~~/** markdown
// wrappers), so "Partially superseded" and "Draft (not yet implemented)" do not
// trip; only an unambiguous done/superseded does.
// Horizontal whitespace only ([ \t], never \s): the match must stay on the
// status line so a paragraph several lines below "Status:" cannot cross-match.
const TERMINAL = /^[ \t]*[*~]*status[*~]*[ \t]*[:=][ \t]*[*~]*[ \t]*(implemented|complete|completed|done|shipped|landed|merged|accepted|approved|superseded|replaced|archived|obsolete|retrospective|reversed)\b/im;
const specFiles = tracked("'*specs/*.md'").filter((p) => !p.endsWith("/README.md"));
for (const f of specFiles) {
  if (TERMINAL.test(specProse(f))) {
    flags.push(`SPEC TERMINAL STATUS  ${f}\n    -> harvest its decision into docs/adr/ and delete the spec (git keeps it).`);
  }
}

// --- Smell 2: orphaned / stale Proposed ADRs -------------------------------
const adrDir = "docs/adr";
const allSpecText = specFiles.map((f) => { try { return readFileSync(f, "utf8"); } catch { return ""; } }).join("\n");
const adrs = existsSync(adrDir)
  ? readdirSync(adrDir).filter((n) => /^\d{4}.*\.md$/.test(n))
  : [];
for (const name of adrs) {
  const path = `${adrDir}/${name}`;
  if (!/^\s*-?\s*\**status\**\s*[:=]\s*\**\s*proposed\b/im.test(head(path))) continue;
  const num = name.slice(0, 4);
  const base = name.replace(/\.md$/, "");
  const referenced =
    allSpecText.includes(base) ||
    allSpecText.includes(`ADR-${num}`) ||
    allSpecText.includes(`adr/${num}`);
  let addDate = null;
  try {
    addDate = execSync(`git log --diff-filter=A -1 --format=%ad --date=short -- "${path}"`, { encoding: "utf8" }).trim();
  } catch {}
  const ageDays = addDate ? Math.round((TODAY - new Date(addDate)) / 86400000) : null;
  if (!referenced) {
    flags.push(`ADR PROPOSED, ORPHANED  ${path}\n    -> no in-tree spec references it; if the work landed, flip Status to Accepted; if abandoned, supersede it.`);
  } else if (ageDays !== null && ageDays > STALE_DAYS) {
    flags.push(`ADR PROPOSED, STALE (${ageDays}d)  ${path}\n    -> still Proposed after ${ageDays} days; land it and flip to Accepted, or supersede it.`);
  }
}

// --- Report ----------------------------------------------------------------
if (flags.length === 0) {
  console.log("doc-hygiene: clean (no terminal-status specs, no orphaned/stale Proposed ADRs).");
  process.exit(0);
}
console.log(`doc-hygiene: ${flags.length} issue(s)\n`);
for (const f of flags) console.log("  " + f + "\n");
process.exit(1);
