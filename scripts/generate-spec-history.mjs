// Regenerates docs/spec-history.md from git history.
//
// The ledger is a materialized view of git, not a filesystem snapshot: git is
// the lossless source of truth for every spec that ever existed and when it was
// added, including ones already deleted from the working tree. Regenerating is
// deterministic for a fixed set of refs and never drops history.
//
// Scope is every `specs/` directory repo-wide (top-level plus per-app and
// per-package), by design: all of them share one dated-scaffolding convention
// and one decision home (docs/adr/), so the timeline and the hygiene gate
// (check-doc-hygiene.mjs) govern the same corpus.
//
// Ref-sensitivity caveat: the source is `git log --all`, so "every spec that
// ever existed" means "on a ref this clone can see." A clone with extra local
// branches counts more; a fresh shallow clone counts fewer. This is the right
// trade: `--all` is what lets the timeline recover specs that only ever lived
// on an unmerged or since-deleted branch. The count tracks the clone's refs,
// not a universal constant; regeneration on the same refs is byte-identical.
//
// There is deliberately NO status column. A spec's self-declared status lies and
// rots; "is this current?" is answered by docs/adr/, not by this index. The only
// state shown is the factual, never-rotting "in tree" vs "removed".
//
// Run from repo root: bun scripts/generate-spec-history.mjs
import { execSync } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";

const raw = execSync(
  "git log --all --diff-filter=A --name-status --date=short --pretty=format:@@@%ad",
  { encoding: "utf8", maxBuffer: 512 * 1024 * 1024 },
);

const isSpec = (p) =>
  /(^|\/)specs\/.*\.md$/.test(p) && !p.endsWith("/README.md");

// git log lists newest first, so the last add we see for a path is its earliest.
let curDate = null;
const firstAdd = new Map();
for (const line of raw.split("\n")) {
  if (line.startsWith("@@@")) { curDate = line.slice(3).trim(); continue; }
  const m = line.match(/^A\t(.+)$/);
  if (m && isSpec(m[1])) firstAdd.set(m[1], curDate);
}

function dateOf(path) {
  const base = path.split("/").pop();
  const m = base.match(/^(\d{4})(\d{2})(\d{2})/); // prefer the spec's own dated name
  return m ? `${m[1]}-${m[2]}-${m[3]}` : firstAdd.get(path) || null;
}
function titleOf(path) {
  return (
    path.split("/").pop()
      .replace(/\.md$/, "")
      .replace(/^\d{8}T?\d{0,6}/, "")
      .replace(/^[-\s]+/, "")
      .trim() || "(untitled)"
  );
}

const rows = [...firstAdd.keys()].map((path) => ({
  date: dateOf(path),
  title: titleOf(path),
  path,
  present: existsSync(path),
}));
rows.sort((a, b) => {
  if (!a.date && !b.date) return a.title.localeCompare(b.title);
  if (!a.date) return 1;
  if (!b.date) return -1;
  return b.date.localeCompare(a.date);
});

const present = rows.filter((r) => r.present).length;
const byYear = rows.reduce((m, r) => {
  const y = r.date ? r.date.slice(0, 4) : "undated";
  (m[y] ||= []).push(r);
  return m;
}, {});

let out = `# Spec History (design timeline)

> **Historical index, not current truth.** Every spec that has ever existed on a
> ref this clone can see, by date, generated from git history so the timeline
> survives any deletion. Scope is every \`specs/\` directory repo-wide.
>
> - For **current decisions and why**, read \`docs/adr/\`.
> - For **how the system works now**, read \`docs/reference/\` and the code.
> - For **shared vocabulary**, read \`docs/CONTEXT.md\`.
> - To **read a removed spec's body**: \`git log --all --full-history -- "<path>"\` then \`git show <sha>:<path>\`.
>
> A row records that a design was explored on that date. It does not mean the
> design is live. There is no status column on purpose: a spec's self-declared
> status is unreliable, so currentness is owned by \`docs/adr/\`. "State" is the
> only fact shown: whether the spec is still in the working tree.
>
> **Regenerate (deterministic per ref set, lossless):** \`bun scripts/generate-spec-history.mjs\`. The totals track the refs this clone can see; \`--all\` is deliberate so the timeline recovers specs that only lived on unmerged or deleted branches.

**${rows.length} specs ever** (${present} still in tree, ${rows.length - present} removed).

`;

const years = Object.keys(byYear).filter((y) => y !== "undated").sort().reverse();
if (byYear.undated) years.push("undated");
for (const year of years) {
  out += `\n## ${year}\n\n| Date | Spec | State | Path |\n|------|------|-------|------|\n`;
  for (const r of byYear[year]) {
    out += `| ${r.date || ""} | ${r.title.replace(/\|/g, "\\|")} | ${r.present ? "in tree" : "removed"} | ${r.path} |\n`;
  }
}

writeFileSync("docs/spec-history.md", out);
console.log(`Wrote docs/spec-history.md: ${rows.length} specs (${present} in tree, ${rows.length - present} removed)`);
