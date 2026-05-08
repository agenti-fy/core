# Releases

agenti-fy ships four artifact streams from a single tag push:

| Artifact | Where | Who needs it |
|---|---|---|
| `ghcr.io/<owner>/coordinator:<v>` | GHCR | Anyone running the coordinator service |
| `ghcr.io/<owner>/agent:<v>` | GHCR | Anyone running an agent fleet |
| `@agenti-fy/setup` | npm | Operators bootstrapping a fresh deploy (`npx @agenti-fy/setup init`) |
| `@agenti-fy/tui` | npm | Operators monitoring a live fleet (`npx @agenti-fy/tui`) |
| `@agenti-fy/shared` | npm | Transitive dep of `setup` and `tui`; not directly installed by operators |
| GitHub release | github.com | Changelog + artifact pointers, one per tag |

`@agenti-fy/agent` and `@agenti-fy/coordinator` are intentionally **not** published to npm — they're Docker-only because their runtime depends on the worktree layout, GitHub-App credential helper, and tini PID-1 baked into the images.

## Cutting a release

Prerequisites (one-time):

1. **`@agenti-fy` npm scope ownership** — confirm at https://www.npmjs.com/settings/agenti-fy/packages.

2. **npm trusted publisher** registered for each of the three publishable packages. Trusted publishing replaces a long-lived `NPM_TOKEN` secret with short-lived OIDC tokens minted per-job — fewer credentials to manage, tighter scope (only this repo + this workflow can publish), and provenance attestations are mandatory rather than opt-in.

   The registration is one-time per package (clicks, no code). For each of `@agenti-fy/shared`, `@agenti-fy/setup`, `@agenti-fy/tui`:

   1. Sign in to npmjs.com with an account that owns (or co-owns) the `@agenti-fy` scope.
   2. Open the package settings page. For a package that doesn't exist yet:
      - Go to https://www.npmjs.com/package/@agenti-fy/shared/access (replace package name in the URL).
      - npm shows "Configure trusted publisher" even before the first publish.
      - For an existing package: same page, "Publishing access" section.
   3. Click **Add trusted publisher** → **GitHub Actions** and fill in:
      - **Organization or user**: `agenti-fy`
      - **Repository**: `core`
      - **Workflow filename**: `release.yml` (NOT a path — just the basename in `.github/workflows/`)
      - **Environment name**: leave blank (we don't gate the publish on a deployment environment)
   4. Save. The publisher appears in the package's "Trusted publishers" list.

   Once registered, the `npm` job in `.github/workflows/release.yml` authenticates automatically — no secrets, no token rotation, no `NODE_AUTH_TOKEN`.

   **First-publish quirk**: npm now allows pre-configuring a trusted publisher for a package that doesn't exist yet (the `/access` page shows the configure button as soon as you own the scope). If your npm account is too old to see that flow, fall back to publishing once with a temporary token to claim the name, then add the trusted publisher and revoke the token. After that, every subsequent publish is OIDC.

3. **GHCR write permission** — automatic via `secrets.GITHUB_TOKEN`. No setup needed beyond the workflow's `permissions: packages: write` block.

Cut steps:

1. **Roll the changelog.** Move everything under `## [Unreleased]` to a new `## [<version>] - <date>` section. Keep `[Unreleased]` empty as the working block for the next cycle.
2. **Bump versions in lockstep.** Every publishable package must agree with the tag. The `verify` job in `.github/workflows/release.yml` enforces this:
   ```bash
   # In one shot, bump all three publishables. Adjust 0.2.0 to your cut.
   for pkg in shared setup tui; do
     jq '.version = "0.2.0"' "packages/$pkg/package.json" > "packages/$pkg/package.json.tmp"
     mv "packages/$pkg/package.json.tmp" "packages/$pkg/package.json"
   done
   # Coordinator and agent versions are independent (they only show up in
   # docker-compose.yml's image tags); bump them too if the docker images
   # changed shape, otherwise leave alone.
   ```
3. **Commit the bump + changelog edit** as one commit (`chore: release v0.2.0`). Push to `main`.
4. **Tag and push.** The tag itself is the publish trigger:
   ```bash
   git tag v0.2.0
   git push origin v0.2.0
   ```
5. **Watch the workflow.** It runs `verify → docker || npm → github-release`. If `verify` fails, fix the underlying issue, delete the tag (`git tag -d v0.2.0 && git push --delete origin v0.2.0`), and re-cut. If `docker` or `npm` fails partway, the cut is half-published — see "Recovering a partial publish" below.

## Versioning policy

- **MAJOR** (`v1.0.0` → `v2.0.0`): breaking change to the routing-label format, dispatch RPC, or `JobResult` schema; or a coordinator/agent version that won't talk to the previous version.
- **MINOR** (`v0.1.0` → `v0.2.0`): new operator-visible feature (a new skill, a new env var that operators must set, a new persona, etc.). The current `[Unreleased]` block accumulates toward a minor.
- **PATCH** (`v0.1.0` → `v0.1.1`): bug fix or doc-only change with no new operator surface.

Pre-1.0 the line between MINOR and MAJOR is fuzzy — until the schemas stabilize, "breaking" is signaled in the changelog rather than enforced by the major number. After 1.0 we follow strict semver.

## Recovering a partial publish

If `docker` succeeds but `npm` fails, or vice versa, do NOT re-tag with the same version — npm refuses overwrites and Docker tags compound confusion. Instead:

- **npm partial** (one or two of three packages published, third failed): re-run the failed `npm` job from the workflow run page (Actions → Release → Re-run failed jobs). This stays inside the OIDC trusted-publish flow and preserves provenance attestations.

  Hand-publishing from a local checkout works as a last resort but is **not** recommended — it requires temporarily disabling trusted publishing on the affected package (or creating a one-shot classic token), and the resulting tarball won't carry a provenance attestation:

  ```bash
  git checkout v0.2.0
  pnpm install --frozen-lockfile
  pnpm -r build
  cp LICENSE packages/<failed-pkg>/LICENSE
  cd packages/<failed-pkg>
  # Requires a temporary classic token in ~/.npmrc; remove after.
  pnpm publish --access public
  ```
  After a manual publish like this, investigate why CI failed and fix before the next cut, OR re-enable trusted publishing if you disabled it.

- **Docker partial** (one image, the other failed): re-run the failed image manually:
  ```bash
  echo $GHCR_PAT | docker login ghcr.io -u <username> --password-stdin
  docker buildx build --push \
    --platform linux/amd64 \
    -t ghcr.io/agenti-fy/<missing-image>:0.2.0 \
    -t ghcr.io/agenti-fy/<missing-image>:latest \
    -f packages/<missing-image>/Dockerfile \
    .
  ```

- **Both succeeded but the GitHub release didn't create**: `gh release create v0.2.0 --generate-notes` from any local checkout.

## Operator install paths after release

```bash
# First-time setup (writes .env from a fresh GitHub-App registration flow)
npx @agenti-fy/setup@latest init

# Run the fleet (assumes .env is in cwd)
docker compose up -d  # uses agentify/{coordinator,agent} from compose.yml
# OR pull from GHCR explicitly:
COORDINATOR_IMAGE=ghcr.io/agenti-fy/coordinator:0.2.0 \
AGENT_IMAGE=ghcr.io/agenti-fy/agent:0.2.0 \
docker compose up -d

# Monitor the fleet
npx @agenti-fy/tui@latest --coordinator-url http://localhost:8080
```
