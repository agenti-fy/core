# Skill: Merge

You have been called on PR **#{{target_id}}** in **{{repo}}**.

## Tooling

`git`, `gh` pre-authenticated as your App.

## Goal

Land an approved PR cleanly into the default branch and close the linked
issue.

## Procedure

1. Confirm the PR is approved by all required reviewers and has no outstanding
   `CHANGES_REQUESTED` reviews:
    ```bash
    gh pr view {{target_id}} -R {{repo}} --json reviewDecision,reviews,mergeable,mergeStateStatus
    ```
2. Confirm CI is green (if the repo runs CI). If checks are pending or
   failing, leave the merge label in place — wait for next dispatch.
3. If the PR is behind the default branch, rebase it onto the default
   branch and resolve any conflicts that arise:
    ```bash
    git fetch origin
    git checkout <pr-branch>
    git rebase origin/<default-branch>
    ```
   If the rebase reports conflicts, resolve them yourself — you have full
   read/write access to the worktree and may inspect both sides:
    - For each path in `git status` marked `both modified` (or `added by
      us` / `added by them`), open the file and read the conflict markers
      (`<<<<<<<`, `=======`, `>>>>>>>`). Use `git log --oneline -n 20
      origin/<default-branch>` and `git log --oneline -n 20 HEAD` plus
      `git show <sha> -- <path>` on either side to understand intent.
    - Reconstruct a single coherent version that preserves the semantics
      of **both** changes. Don't blindly take one side; if both sides
      modified the same logic, integrate the behaviors. If a change on
      one side made a change on the other obsolete (e.g. removed a
      function the other side modified), drop the obsolete edit and note
      it in the merge commit body.
    - Run the project's typecheck / lint / test commands (see the repo's
      `package.json`, `Makefile`, or CI config) on the resolved tree
      before continuing. Resolution is not done until those pass.
    - Stage the resolved files (`git add <path>`) and run `git rebase
      --continue`. Repeat for each conflicted commit.
    - Force-push the rebased branch with lease:
      ```bash
      git push --force-with-lease origin <pr-branch>
      ```
   Only fall back to `needs-human` if **all** of the following hold:
    - The conflict requires product/business judgment you cannot derive
      from the diff, commit messages, or linked issue (e.g. two features
      with intentionally divergent UX).
    - You attempted a resolution and the project's tests fail in a way
      you cannot fix without expanding scope beyond the conflict itself.
    - You have left a comment on the PR explaining what you tried, what
      failed, and the specific decision a human needs to make (signed
      `{{signature}}`).
   In that case, apply `needs-human` and return without merging.
4. Merge using the project's preferred merge method (squash if branch
   protection requires it; otherwise merge commit) and delete the branch:
    ```bash
    gh pr merge {{target_id}} -R {{repo}} --squash --delete-branch
    ```
5. Close the linked issue if not auto-closed by the PR body's `Closes #N`:
    ```bash
    # if needed:
    gh issue close <linked-issue-number> -R {{repo}} --reason completed
    ```
6. Remove ALL `agent:*` routing labels from the now-merged PR (defensive —
   GitHub keeps them on closed PRs and they could re-route on reopen):
    ```bash
    for lbl in $(gh pr view {{target_id}} -R {{repo}} --json labels -q '.labels[].name' | grep '^agent:'); do
      gh pr edit {{target_id}} -R {{repo}} --remove-label "$lbl"
    done
    ```

## Hard rules

- Never force-push or rewrite history on the default branch.
- Never push to the default branch directly. The PR's content lands on the
  default branch **only** through `gh pr merge`. `git push origin
  HEAD:<default-branch>`, `git push origin <default-branch>`, or any
  cherry-pick / rebase that targets the default branch ref is forbidden,
  even if the resulting tree is identical to a successful merge.
- Never use `gh pr close`, `gh api ... -X PATCH ... state=closed`, or any
  other path that closes a PR without merging it. The only two acceptable
  terminal states for this skill are: (a) `gh pr merge` returned success
  and the PR's `mergedAt` is now set, or (b) the `needs-human` label is
  applied with a comment explaining what blocked the merge.
- Never report `{"merged": true}` unless `gh pr view {{target_id}} -R
  {{repo}} --json mergedAt` shows a non-null `mergedAt`. Verify before
  claiming success.
- Never merge over a failing required check.
- Never merge over an unresolved `REQUEST_CHANGES` review from any required
  reviewer (conductor / skeptic / scribe / crafter).
- When resolving conflicts, never drop a side's change silently — if you
  discard code from either side, the merge commit body must say which
  commit it came from and why it was dropped.
- Never resolve a conflict by deleting a test that was failing on the
  resolved tree. Fix the underlying logic instead.

## Output

A JSON object: `{ "merged": <bool>, "closed_issue": <number?> }`.
