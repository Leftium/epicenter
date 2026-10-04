# OPFS migration acceptance

Date: 2026-10-04

The candidate started from branch commit `401708bb48` with only the Vocab and
Whispering migration paths and Vocab workspace lock entry. Chrome exercised
Vocab at `http://localhost:5232` from the clean candidate checkout.

The existing fixture expression remained available. Editing its note and
blurring saved it; reload restored that note. A second tab then saved a
replacement while the first tab held an unsaved note. The first tab retained
its draft and offered an explicit choice. Choosing Save mine instead published
the retained draft, and another reload restored it.

The migration uses one release Local OPFS folder under the stable app ID.
These journeys exercised the existing OPFS fixture. No model request or
account sign-in occurred.

Clean break, recorded after this run: the shared browser opener no longer
copies an earlier IndexedDB folder, and Vocab no longer offers the
earlier-account import. The
journeys above did not use the import. This record does not say whether the
fixture first reached OPFS through the copy, and the clean break has not been
exercised in a browser. See [the clean-break review](opfs-clean-break-review.md).

Coordinator checks on the clean candidate passed: frozen dependency install,
105 tests with 677 assertions, typecheck without errors or warnings, and a
static production build. The final review removed unused exports and direct
dependencies and repeated the frozen install, focused editor tests, full Vocab
suite, typecheck, and build. Those counts include the earlier-account import
tests, which the clean break removed.

![Vocab after the saved draft survived reload](opfs-migration.png)
