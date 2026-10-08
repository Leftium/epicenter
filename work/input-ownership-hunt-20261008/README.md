# Input ownership hunt: adjudicated execution list

2026-10-08. Three parallel read-only reviews plus coordinator source checks.
No application code changed in this wave. This is a ranked implementation list,
not runtime acceptance or a claim of exhaustive coverage.

## Recommended next waves

| Order | Target | Grounded change | What disappears |
| --- | --- | --- | --- |
| 1 | Vocab WordsView | One replacement-based import draft; clear import/focus only for the submitted value | Split review/selection reset protocol and stale-result overwrites |
| 2 | FileBrowser in Todos, Honeycrisp and Whispering | One naming draft with action, target and value; completion respects current draft and focus lifetime | DOM-only value submission plus unconditional dismissal/navigation |
| 3 | Honeycrisp FolderNav | Keep unfinished name through failure; use captured create/rename intent | Preemptive discard and inference of create intent from a vanished rename target |
| 4 | Local Books RowDetail | Pass captured normalized request variables, invalidate submitted row, preserve newer draft | Request dependence on live props and parallel field reset |
| 5 | Honeycrisp FileView | Shared function binding, retaining newline conversion and session | Separate value/native event forwarding for this field |

The first four include concrete correctness findings visible in the current
source. Before applying them, add focused deferred-response coverage and then
exercise the affected UI. Preserve owner uncertainty/receipt semantics and guard
Enter/blur duplicate admission. Naming completion must not steal focus or open an
old target after a new form begins. A metadata identity check alone does not
protect newer text inside the same DOM-held form.

Local Books requires no real QuickBooks write for verification. Stub the API.
Its form lifetime on selection remains a deliberate policy: do not silently
key away unfinished input. Existing unrelated dirty/staged work must remain
untouched; app changes should be integrated and committed separately.

## Decisions and lower-priority candidates

- Matter field saves close controls before async persistence succeeds and retain
  only failure text. Choose retained explicit-submission drafts or an accepted
  field publisher before changing this boundary. Do not delete the current draft.
- Whispering connection settings can become one form object only while preserving
  saved normalization, shared ownership, endpoint/key behavior and newer typing.
  Deferred URL/model saves need verification before choosing the reset policy.
- Filename bars following their saved names have a similar reset-policy question.
- Local Mail SavedQueries and Local Books report parameters can group related
  fields, but their baselines, normalization and run/save distinction remain.
  This is lower-priority representation cleanup.
- Matter vault-list snapshot appears unnecessary for its current plain,
  replace-only array and read-only consumers. This is a bounded copy removal,
  not a general rule against snapshots.
- Whispering's known Source/Fields workspace migration remains separate from
  these fresh submission findings. Do not expand it into unrelated mode cleanup.

## Keep

Keep accepted body/raw-file owners, publication queues and saved baselines;
rich widget documents, history and selections; operation identities and unknown
outcomes; genuine scalar drafts; shared input retirement; unfinished date phrases.
No additional convincing mirrored component body was found in the three core
editor apps. Rune counts are not a measure of improvement.

## Evidence

- [Editor bindings](editor-bindings.md): Capture, Todos and Honeycrisp.
- [Submission forms](submission-forms.md): Vocab and Whispering.
- [Other apps](other-apps.md): Matter, Skills, Mail, Books and shared UI.
- [Coordinator checks](coordinator.md): deciding sources, Home/Git keeps and
  additional grep recipes.
- [Reviewed source versions](source-versions.json): working-tree content hashes.

Reports list inspected files before analysis and include proposed shapes,
deletion prizes, information to preserve and focused verification. Claims are
static source findings. No browser, native hardware, provider or financial
acceptance is implied. The coordinator checked deciding event paths and kept
policy-dependent findings separate from ready implementation candidates.
