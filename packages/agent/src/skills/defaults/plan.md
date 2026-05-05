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

Convert the issue into a **deep, comprehensive engineering plan** and fan it
out into **as many atomic subtasks as the work genuinely requires** — no
artificial cap, no artificial floor. A 2-line bug fix gets 1 subtask. A new
subsystem might get 40. The number is whatever lets each subtask stay small
and shippable on its own. THIS IS A FAN-OUT STEP: every child issue you
create must carry an `agent:<persona>:<method>` label so a downstream agent
picks it up automatically. No human will re-label them.

## What "comprehensive plan" means

A good plan is the engineering document the team would write before touching
code. The parent issue body, after this skill runs, should let any agent (or
human) understand:

- **Problem framing** — what the user is actually trying to achieve and why,
  not just a restatement of the issue title.
- **Current state** — what exists today in the codebase that's relevant:
  modules, data flow, entry points, key files (with paths). Cite real code,
  not assumptions.
- **Target state** — the end-state architecture: components, data flow,
  contracts/interfaces, storage, deployment surface. Diagrammatic prose is
  fine; ASCII diagrams welcome where they clarify.
- **Approach** — the sequence of changes that get us from current to target,
  grouped into phases when ordering matters.
- **Alternatives considered** — at least one alternative for any non-obvious
  design choice, with one or two sentences on why you rejected it. If you
  considered nothing, you didn't think enough.
- **Risks & unknowns** — things that could go wrong, performance cliffs,
  data migrations, backward-incompatibilities, third-party API quirks. Each
  with a mitigation or "we'll know more after subtask #N".
- **Test strategy** — how we'll prove correctness. Unit, integration, e2e,
  manual verification — and which subtasks own which tests.
- **Out of scope** — explicit list of things you considered and decided not
  to do in this plan, with one-line justifications. Future-you needs this.

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
   If the issue is ambiguous, write your reading of it explicitly in the
   parent body's "Problem framing" — don't silently disambiguate.
2. **Investigate the codebase deeply.** Don't skim. Concretely:
    - Map the relevant modules: read directory structure, package
      manifests, entry points.
    - For every component the plan will touch, open the file(s) and read
      enough to know the existing shape: types, function signatures, how
      it's wired in, who calls it.
    - Grep for existing patterns the plan should follow (e.g. how are
      similar features structured today?).
    - Check tests for the touched areas — they encode invariants you
      must preserve.
    - Cite real paths and line numbers in the plan. Hallucinated paths
      are a hard failure.
   For a non-trivial change, expect this step to read 10–50 files. Skipping
   it produces shallow plans that the implementer can't act on.
3. **Decompose into as many atomic subtasks as the work requires.** No fixed
   range — the count is a function of scope, not a target. A localized fix
   may be 1 subtask; a new subsystem may be 30+. Each subtask must:
    - Touch a small number of files (ideally 1–4; never an entire package
      rewrite).
    - Have a clear, narrow acceptance criterion you can describe in 2–4
      bullets.
    - Be reviewable in under ~15 minutes by a human.
    - Pick exactly one persona from the table above.
    - Pick exactly one task method (almost always `implement`; use `plan`
      only when the subtask is itself a sub-epic that needs further
      decomposition — prefer further breakdown over a `plan` subtask).
    - Declare its dependencies on other subtasks explicitly via a
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
   When in doubt, split: 30 small issues with a clean DAG ship; 5 huge
   issues stall.

   **Don't pad either.** Don't synthesize subtasks to hit a target count.
   Don't split a coherent atomic change into pieces that aren't
   independently shippable. The right granularity is "the smallest unit
   that makes sense as one PR" — no smaller, no larger.

   **Phasing for large plans.** When the subtask count is high (say, >15),
   group them into ordered phases (Phase 1: foundations, Phase 2: core,
   Phase 3: polish, etc.) and use `Depends on:` to encode the phase
   boundaries. The parent's Plan section names the phases; each subtask
   notes its phase in its Notes section. This keeps the implementer
   pipeline well-ordered without a single bottleneck issue.
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
5. Rewrite the parent issue body as the **plan document**. Sections below
   are the minimum; add more (e.g. "Migration", "Rollback", "Open
   questions") whenever the plan calls for them. Length should match scope
   — small fix: tight; large feature: pages. Don't pad. Don't compress.

    ```bash
    cat > /tmp/parent_body.md <<'EOF'
    ## Problem framing
    <what the user is trying to achieve and why; the underlying need, not
    just a paraphrase of the title>

    ## Current state
    <what exists today that's relevant: modules, data flow, entry points.
    Cite real paths like `packages/foo/src/bar.ts:123`. Be concrete.>

    ## Target state
    <end-state architecture: components, contracts, storage, deployment.
    ASCII diagrams welcome where they help.>

    ## Approach
    <the sequence of changes that get us from current → target. For large
    plans, organize into phases:
      - **Phase 1 — <name>**: <what + why this is first>
      - **Phase 2 — <name>**: <…>
      - **Phase 3 — <name>**: <…>
    For small plans, a numbered list is fine.>

    ## Alternatives considered
    - **<alternative 1>** — <one or two sentences on why rejected>
    - **<alternative 2>** — <…>

    ## Risks & unknowns
    - **<risk>** — <mitigation, or "we'll know after #N">
    - **<unknown>** — <how/when we'll resolve it>

    ## Test strategy
    <unit / integration / e2e split, which subtasks own which tests, what
    verification looks like>

    ## Out of scope
    - <thing> — <one-line reason>
    - <thing> — <one-line reason>

    ## Subtasks
    <If you used phases above, group the checklist by phase. Otherwise
    list flat.>
    ### Phase 1 — <name>
    - [ ] #<n1> Title (agent:<persona>:implement)
    - [ ] #<n2> Title (agent:<persona>:implement)
    ### Phase 2 — <name>
    - [ ] #<n3> Title (agent:<persona>:implement)
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
- **No artificial cap on subtask count.** If the plan honestly needs 40
  subtasks, create 40. If it needs 2, create 2. The 5–15 range from
  earlier versions of this prompt is no longer the target. Fit the
  decomposition to the work, not to a number.
- **No artificial inflation either.** Don't fragment a coherent atomic
  change to look thorough. The smallest-unit-that-is-one-PR is the
  threshold; going below it creates coordination overhead with no
  shipping benefit.
- Each subtask should be independently shippable where possible. Use
  `Depends on:` only when ordering is genuinely required (e.g. types
  before consumers); avoid serializing work that could run in parallel.
- The plan document in the parent body must be honest about the plan's
  depth. If you skipped "Alternatives considered" because the choice was
  forced (only one viable approach), say so in one line — don't omit
  the section silently.
- Never invent file paths or APIs. Read the repo first. Cite paths.
- Sign every issue body and the rewritten parent body with `{{signature}}`.
- If a child issue already exists for a subtask (idempotent re-run), edit it
  in place rather than creating a duplicate.

## Output (returned to the runner)

A JSON object: `{ "child_issues": [<numbers>] }` where the array lists the
real issue numbers you created (or edited, on idempotent re-runs).
