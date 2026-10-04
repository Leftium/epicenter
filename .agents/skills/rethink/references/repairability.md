# Repairability

> **Protect information. Tolerate repairable inconsistency.**

Before adding or retaining machinery, ask what information it protects. If it
only prevents an inconsistency, show how someone could discover and repair that
state. Simplify once a repair path exists.

Use this judgment when a file-authoritative workflow accumulates preflight
checks, transactions, rollback, or recovery states to keep relationships
consistent. Epicenter's ordinary files let humans and coding agents inspect
source and make another edit. Other programs can change those files too;
coordination among our own callers cannot prevent every inconsistent state.

## Establish the repair path

A state is repairable when the source remains accessible, the problem can be
discovered, and another explicit edit can correct it without reconstructing
erased intent. Follow one concrete failure through discovery and correction.
Name who makes the correction and what effort it costs. "An agent could fix it"
does not establish a repair path. A cheap local check may cost less than frequent
repair; removing code is no win if it gives the person more work.

Repair can produce a useful new state rather than restore the previous one.
A note whose folder was intentionally deleted can be reassigned elsewhere.

## Find what can disappear

For each candidate check or coordination mechanism, identify the information
it protects and the state it prevents. If removing it only permits a visible,
repairable inconsistency, name the checks, states, retries, or workflow steps
that could disappear. Establish visibility and repair before removing them.

Consider whether the proposed cleanup itself discards useful information.
Rewriting every note's folder reference to keep relationships valid can erase
the membership that would let someone restore the folder later. Making fewer
edits may preserve more information and remove the need to coordinate drafts.

## Compare two failures

**A note points to a missing folder.** Keep the note accessible, identify the
missing folder, and allow reassignment or restoration. Deleting only the folder
file could avoid membership scans and note rewrites. This is a product choice:
restoring or reusing that folder ID would reattach the notes. Verify the chosen
behavior and update the deletion message before changing the workflow.

**A save replaces a newer draft or discards unknown fields.** Diagnostics cannot
reconstruct content that nothing retained. Keep protections against accidental
replacement, retain unsaved input on failed or uncertain writes, and patch
only the requested source. Git helps only for versions it actually captured.

Intentional deletion and whole-file replacement still have their explicit
contracts. This principle does not require making every operation reversible
or accepting every value through a typed API. A structured patch should refuse
when finding its target requires guessing or discarding source; raw-text editing
can provide the repair path.

## Verify the bargain

During design review, show the proposed failure and repair path, marking what
remains unverified. Before changing runtime behavior, exercise a failure, reopen
the files, find the problem, and make the correction. Check that unrelated
content and drafts survived and unaffected work continued.
Report known effects and uncertainty; do not label an unknown save successful
merely because a later read finds the intended text.

The [decision draft](../../../../docs/adr/0503-file-authoritative-workflows-preserve-information-and-tolerate-repairable-states.md)
records the rationale and the proposed Honeycrisp application. This reference
supplies review judgment, not a new storage or editor contract.
