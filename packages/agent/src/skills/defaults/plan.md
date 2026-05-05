# Skill: Plan

You have been called on issue **#{{target_id}}** in **{{repo}}**.

## Tooling

The container has `git`, `gh` (GitHub CLI), and the standard read tools. `gh`
is pre-authenticated as your App via `GH_TOKEN` — use it for ALL GitHub
mutations (creating issues, editing bodies, applying labels).

## Routing label format

Every routable item carries a single combined label per (persona, method):

  `agent:<persona>:<method>`

Methods in label form: `plan`, `implement`, `review`, `address-review`, `merge`.
A single PR can carry MULTIPLE such labels — e.g. four reviewers at once
(`agent:conductor:review`, `agent:skeptic:review`, `agent:scribe:review`,
`agent:crafter:review`) — and each evolves independently. NEVER use the old
two-label `agent:X` + `task:Y` format; the work-poller doesn't recognize it.

## Goal

Convert the issue into a comprehensive implementation plan and break it into
small, independently shippable subtasks. THIS IS A FAN-OUT STEP: every child
issue you create must carry an `agent:<persona>:<method>` label so a downstream
agent picks it up automatically. No human will re-label them.

## Persona routing — pick the right persona for each subtask

| Persona        | Best-fit subtasks                                                       |
| -------------- | ----------------------------------------------------------------------- |
| `theorist`     | data modeling, type design, algorithm choices, schema design            |
| `tinkerer`     | feature implementation, business logic, UI behavior, refactors that ship|
| `optimizer`    | performance, memory, CPU, build-size, query-plan work                   |
| `glue`         | infrastructure, CI/CD, build, devops, plumbing between systems          |
| `skeptic`      | tests, security hardening, vulnerability fixes, validation, error paths |
| `crafter`      | UI/UX, visual styling, copy, accessibility                              |
| `scribe`       | docs, README, comments, ADRs, wiki, changelogs                          |
| `conductor`    | architectural decisions that span multiple components                   |
| `orchestrator` | further fan-out planning if a subtask is itself epic-sized              |

If a subtask doesn't obviously fit one bucket, default to `tinkerer`.

## Procedure

1. Read the parent issue body (`gh issue view {{target_id}} -R {{repo}}`).
   Identify the user's intent, the constraints, and what "done" looks like.
2. Inspect the repository at HEAD to ground your plan in the actual codebase.
   Use Read / Grep / Glob; do NOT hallucinate paths.
3. Decompose into small subtasks. Aim for **5–15** subtasks. **Each subtask
   must be small enough that an implementer can finish it in roughly ONE
   focused PR with a bounded turn budget.** Concretely:
    - Touches a small number of files (ideally 1–4; never an entire package
      rewrite).
    - Has a clear, narrow acceptance criterion you can describe in 2–4
      bullets.
    - Can be reviewed in under ~15 minutes by a human.
    - Picks exactly one persona from the table above.
    - Picks exactly one task method (almost always `implement`; use `plan`
      only when the subtask is itself a sub-epic that needs further
      decomposition — prefer further breakdown over a `plan` subtask).
    - Declares its dependencies on other subtasks explicitly via a
      `## Dependencies` section in its body (see step 4). The work-poller
      uses these to gate dispatch — a subtask whose deps are still open
      stays out of the routing pool until the dep closes (which happens
      automatically when the dep's PR merges via `Closes #N`). Use
      dependencies to express ordering (e.g. data model before
      implementer code that uses it). Cycles deadlock — keep the graph
      a DAG.

   **If a subtask feels like it'll take more than ~150 turns to implement
   (large refactor, sweeping rename, multi-package change), split it.**
   The implementer SDK has a finite turn budget; oversized subtasks fail.
   Prefer 10 small issues over 3 huge ones.
4. For each subtask, create a child issue. The Dependencies section uses
   the literal phrasing `Depends on: #N, #N` — that's what the coordinator
   parses; markdown bold + leading list markers around it are fine.

    ```bash
    gh issue create -R {{repo}} \
      -t "Short imperative title" \
      -b "$(cat <<'EOF'
    Parent: #{{target_id}}

    ## Context
    <one or two sentences pointing the implementer at the parent>

    ## Acceptance criteria
    - bullet list of what "done" looks like
    - keep it boringly specific

    ## Dependencies
    - **Depends on**: #<n>, #<n>   (omit this line if no deps)

    ## Notes
    <relevant code paths, gotchas, file pointers>

    ---
    {{signature}}
    EOF
    )" \
      -l "agent:<persona>:implement"
    ```
   Capture each new issue number from the URL `gh issue create` prints.
5. Rewrite the parent issue body with three sections — Summary / Plan /
   Subtasks — where Subtasks is a checklist of real `- [ ] #<n>` references:
    ```bash
    cat > /tmp/parent_body.md <<EOF
    ## Summary
    <one paragraph>

    ## Plan
    <technical approach: components touched, ordering, risks>

    ## Subtasks
    - [ ] #<n1> Title for first subtask (agent:<persona>:implement)
    - [ ] #<n2> Title for second subtask (agent:<persona>:implement)
    ...

    ---
    {{signature}}
    EOF
    gh issue edit {{target_id}} -R {{repo}} --body-file /tmp/parent_body.md
    ```
6. Remove the parent's routing label — planning is complete, the parent is
   now a tracking issue:
    ```bash
    gh issue edit {{target_id}} -R {{repo}} \
      --remove-label "agent:{{persona}}:plan"
    ```

## Hard rules

- You MUST create at least one child issue. Returning a plan in your final
  text WITHOUT calling `gh issue create` is a failure — no human will pick
  it up afterwards.
- Subtasks must be small. If you find yourself writing a subtask titled
  "Refactor X" or "Rewrite Y" or "Add the entire Z system", STOP and break
  it into ≤4-file pieces. A 30-file subtask is a planning failure.
- Each subtask should be independently shippable where possible. Use
  `Depends on:` only when ordering is genuinely required (e.g. types
  before consumers); avoid serializing work that could run in parallel.
- Never invent file paths or APIs. Read the repo first.
- Sign every issue body and the rewritten parent body with `{{signature}}`.
- If a child issue already exists for a subtask (idempotent re-run), edit it
  in place rather than creating a duplicate.

## Output (returned to the runner)

A JSON object: `{ "child_issues": [<numbers>] }` where the array lists the
real issue numbers you created (or edited, on idempotent re-runs).
