# Progressive sign-in collapse: execution prompts

Companion to `specs/20260701T151347-progressive-sign-in-collapse.md` (the
canonical plan; if this file disagrees with the spec or ADR-0088, they win).
Three sections: kickoff prompts for the executing agent, grill prompts to run
against each finished wave, and the check-in protocol for the coordinating
reviewer. Delete this file with the spec in Wave 4.

---

## 1. Executor kickoff prompts

Paste one per wave into a fresh agent session started at the repo root on a
fresh branch off `main`. Fill `<...>` slots.

### Wave 1 kickoff (extract the kit)

```txt
Read specs/20260701T151347-progressive-sign-in-collapse.md and
docs/adr/0088-sign-in-is-an-enhancement-never-a-door.md in full before
touching code. Load the skills: workspace-app-composition, svelte, auth,
git, writing-voice.

Execute Wave 1 only: extract connectLocalFirst and reloadOnOwnerChange into
@epicenter/svelte/auth and the sign-in migration kit into
@epicenter/app-shell, then point Whispering at all three and delete its
app-local copies. This wave is refactor-only: Whispering behavior must be
byte-identical. Follow the extraction catalog in the spec's Architecture
section; the seeds are the exact files listed under References.

Rules: standalone commits, one extraction per commit, stage specific files
only. Do not convert any gated app in this wave. Do not modify
packages/workspace. Do not copy AGPL app code into MIT packages. When the
spec leaves something open, decide, and record the decision in the PR body.

Done means: spec checkboxes 1.1-1.6 checked, repo typecheck passes,
Whispering's tests pass, and the Invariants block in the spec passes.
Open a PR titled against main and list every judgment call in the body.
```

### Wave 2 kickoff (honeycrisp, proves the recipe)

```txt
Read specs/20260701T151347-progressive-sign-in-collapse.md (especially "The
per-app conversion recipe" and the honeycrisp before/after call sites) and
docs/adr/0088-sign-in-is-an-enhancement-never-a-door.md. Load the skills:
workspace-app-composition, svelte, sveltekit, auth, git, writing-voice.
Wave 1 must already be merged; verify connectLocalFirst exists in
@epicenter/svelte/auth before starting, and stop if it does not.

Execute Wave 2: convert apps/honeycrisp using the recipe's seven steps, in
order, one step per commit where practical. The gate and the (signed-in)
route group are deleted, the workspace singleton is never null, and
AccountPopover gains instanceConnect. Sweep every hit of
rg -n "session\.(require|current)|requireHoneycrisp" apps/honeycrisp/src.

Done means: the per-app Invariants greps for honeycrisp pass, typecheck and
honeycrisp tests pass, and you completed the manual smoke in recipe step 7
(signed-out create, sign in, Add migration, sign out, nothing deleted).
List every feature-affordance judgment call in the PR body.
```

### Wave 3 kickoff (one per app: opensidian / vocab / tab-manager)

```txt
Read specs/20260701T151347-progressive-sign-in-collapse.md and the merged
honeycrisp conversion PR (#<PR>); the honeycrisp diff is your template.
Load the skills: workspace-app-composition, svelte, auth, git,
writing-voice (plus wxt for tab-manager, sveltekit for the others).

Execute the per-app recipe on apps/<app>. App-specific notes from the spec:
<paste the app's bullet from "Per-app judgment points">.

Done means: the per-app Invariants greps pass, typecheck and the app's tests
pass, manual smoke per recipe step 7 done, judgment calls in the PR body.
Do not touch the other apps or shared packages; if a shared change seems
required, stop and report instead of making it.
```

### Wave 4 kickoff (delete the old world)

```txt
Read specs/20260701T151347-progressive-sign-in-collapse.md. Waves 1-3 must
all be merged; verify with the Invariants block before starting.

Execute Wave 4: delete SignedOutScreen, make AccountPopover.instanceConnect
required, rewrite the workspace-app-composition skill (both .agents/skills
and .claude/skills copies) to one composition shape, flip ADR-0088 to
Accepted, delete the spec and its .prompt.md companion, add the
docs/spec-history.md entry, and run bun scripts/check-doc-hygiene.ts.
Do NOT delete createSession (demoted, kept for the vault session).
```

---

## 2. Grill prompts (run after each wave, fresh reviewer context)

Run each against the wave's diff (`git diff main...<branch>`) with no other
context loaded. The reviewer should try to kill the work, not approve it.

### Wave 1 grill

```txt
You are reviewing a refactor that claims zero behavior change. The diff
extracts Whispering's boot-branch, reload-on-owner-change, and sign-in
migration into shared packages. Attack these specifically:

1. Diff the extracted functions against the deleted Whispering originals
   line by line. Any semantic drift (a default changed, a guard dropped, an
   await moved, transact boundaries changed) is a finding.
2. connectLocalFirst must read auth.state exactly once, synchronously, with
   no reactive subscription. Any $state, $derived, or onStateChange inside
   it is a finding.
3. The migration kit must stay flag-free: no "migrated" boolean anywhere,
   clearLocal only after a fully resolved copy, dialog undismissable while
   a copy or delete is in flight.
4. License boundary: confirm no code moved from apps/* or app-shell into an
   MIT package (packages/workspace, packages/identity, packages/ui).
5. Table enumeration: the shared copy iterates shared table names. What
   happens when source and target schemas disagree (a table exists in one
   record only)? If the behavior is silent, that is a finding.
Report findings with file:line, most severe first, or state "no findings"
per item.
```

### Waves 2-3 grill (per app)

```txt
You are reviewing the conversion of apps/<app> from an auth-gated app to a
local-first app per docs/adr/0088. The claim: the app is fully usable signed
out, and sign-in only adds sync. Attack:

1. Boot signed out (mentally or by running it): trace the singleton from
   module load to first paint. Any path that throws, renders blank, or
   assumes ownerId while signed out is a finding. Pay attention to former
   require<App>() call sites: each one used to be guarded by the gate.
2. Feature honesty: list every feature that hits the network or relay.
   For each, what does a signed-out user see? A dead button or silent
   failure is a finding; an inline affordance is correct.
3. Migration wiring: does check() fire exactly once per boot, only when
   signed in? Does Add copy into the OWNER doc and clear the BARE doc, not
   the reverse? Is the dialog reachable on the very first signed-in boot?
4. Deletion completeness: run the spec's per-app Invariants greps. Any hit
   is a finding. Also grep for the app's old /sign-in or redirect paths in
   links and navigation.
5. Reload safety: does anything in this app break across
   location.reload() mid-action (an in-flight editor save, recording,
   terminal session)? If yes, is disabledReason wired to the popover?
Report findings with file:line, most severe first.
```

### Wave 4 grill

```txt
Review the deletion wave. Attack: (1) any remaining SignedOutScreen import
or export; (2) instanceConnect now required: every AccountPopover call site
passes it and the JSDoc no longer says optional; (3) the
workspace-app-composition skill: no Shape A/Shape B language survives, the
one documented shape matches what the five apps actually do, and both skill
copies are identical; (4) createSession still exists and its JSDoc forbids
owning a workspace lifecycle; (5) ADR-0088 is Accepted, the spec and prompt
files are gone, spec-history has the entry, and check-doc-hygiene passes.
```

---

## 3. Check-in protocol (coordinating reviewer)

When the operator checks in with a branch or PR, verify in this order and
report drift bluntly:

```txt
1. git log --oneline main..<branch>   commits are standalone, one concern each,
                                      no AI attribution, specific-file staging
2. The wave boundary                  nothing outside the wave's file set;
                                      Wave N started only after Wave N-1 merged
3. The Invariants block               run the greps from the spec verbatim
4. Semantic spot-checks               Wave 1: extracted vs original diff.
                                      Waves 2-3: three former require* call
                                      sites, the migration wiring, one
                                      signed-in-only feature affordance
5. The PR body                        judgment calls actually listed; smoke
                                      test actually claimed and plausible
6. Spec checkboxes                    updated in the same PR
```

Escalate (stop the executor, redesign) when: a new auth state appears, a
second doc-selection mechanism appears beside connectLocalFirst, migration
grows a persisted flag, a shared package gains an app-specific branch, or
the executor edits packages/workspace or apps/api/ui.
