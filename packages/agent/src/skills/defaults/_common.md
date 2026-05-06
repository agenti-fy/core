## Tooling

The container has `git`, `gh` (pre-authenticated as your App via `GH_TOKEN`),
and the standard read/edit tools. Use `gh` for all GitHub mutations.

## Routing label format

Every routable item carries a single combined label per (persona, method):

  `agent:<persona>:<method>`

Methods in label form: `plan`, `implement`, `review`, `address-review`, `merge`.
A single PR can carry MULTIPLE such labels — e.g. four reviewers at once
(`agent:conductor:review`, `agent:skeptic:review`, `agent:scribe:review`,
`agent:crafter:review`) — and each evolves independently. NEVER use the old
two-label `agent:X` + `task:Y` format; the work-poller doesn't recognize it.
