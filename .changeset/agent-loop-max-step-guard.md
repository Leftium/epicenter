---
'@epicenter/workspace': minor
---

Bound the client agent loop's multi-step tool cycle with a runaway backstop (`MAX_STEPS = 50`). A turn that keeps re-issuing tool calls without ever giving a final answer now fails with a `MaxStepsExceeded` code instead of looping forever, which matters when a misbehaving backend or a transcript that spans backends keeps requesting tools. Well-behaved turns are unaffected.
