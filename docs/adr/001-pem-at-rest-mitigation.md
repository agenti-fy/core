# ADR-001: PEM-at-rest mitigation strategy for the setup wizard

- **Status**: Accepted
- **Date**: 2026-05-07
- **Author**: 🎭 The Conductor · Engineering Lead
- **Issue**: #481 (follow-up from #479)
- **Follow-up implementation plan**: #484

---

## Context

The `@agentify/setup` wizard guides operators through a one-time bootstrap:
it creates 9 GitHub Apps (one per persona) plus a coordinator, captures their
PEM private keys via GitHub's App Manifest conversion endpoint, and writes them
into `.env` for docker-compose.  The wizard is **resumable** — an interrupted
run (browser closed, OAuth timeout, Ctrl-C) resumes from the saved checkpoint
at `~/.config/agentify/setup-<prefix>.json` (mode `0o600`, parent dir
`0o700`, atomic-rename writes).

**The problem**: when the apps phase is implemented (tracked in #484), after
every per-persona completion it will need to call `saveState(checkpointState)`
to preserve resumability — which will write the raw PEM private key to the
checkpoint file.  While filesystem permissions offer a first line of defense,
plaintext private keys at rest represent a material threat surface: backup
tarballs, volume-mount mishaps, OS snapshots, `~/.config` sync tools,
debugging copies passed around — any of these exposes 9 high-value private
keys in a single file.

**The hard constraint**: GitHub's App Manifest conversion endpoint returns
each PEM **exactly once**.  Strategies that discard the PEM without persisting
it force the operator to rotate keys for all 9 Apps via the GitHub UI on every
resume — a severe UX penalty and a significant operational risk.

Convention: `WizardStateSchema.anthropic` is typed as `optional()` and v1
always omits the field from the state file by convention (`state.ts:76-80`).
This is absence-by-design for long-lived secrets that are rarely worth
checkpointing — not an active strip function.  PEMs cannot follow the same
pattern because they must survive process interrupts to preserve resumability;
hence the encrypt-at-rest strategy below.

---

## Decision

**Chosen strategy: encrypt-at-rest (passphrase-derived key, scrypt + AES-GCM)**

PEM values stored in the checkpoint file will be encrypted with a key derived
from a short operator-supplied passphrase via `scrypt`, using AES-256-GCM as
the AEAD cipher.  The passphrase is **never** written to disk; the derived key
lives only in process memory for the duration of the wizard session.  On
resume the operator is prompted for the same passphrase to decrypt.

---

## Evaluation of candidates

### Strip-and-re-enter

The PEM is stripped from state before every save (mirroring `anthropic.value`).
On resume the wizard would need to re-acquire the PEM — but the App Manifest
endpoint returns it only once, so "re-acquire" means generating a new private
key in the GitHub UI and re-running the manifest flow for every interrupted
persona.  For 9 Apps that is 9× `Generate a private key` clicks, re-running
the OAuth dance for each, and restarting the affected phase from scratch.
**Verdict: rejected.**  Resumability is a first-class requirement; this
strategy silently destroys it.

### Encrypt-at-rest (passphrase + scrypt + AES-GCM) ✅ chosen

A short passphrase is collected from the operator once per wizard session
(first run: prompted on entry; resume: prompted before decrypting the saved
state).  A 32-byte encryption key is derived with `crypto.scryptSync` (N=2¹⁴,
r=8, p=1 — standard interactive parameters) from the passphrase and a
randomly-generated 32-byte salt stored alongside the ciphertext.  Each PEM is
independently encrypted with `crypto.createCipheriv('aes-256-gcm', ...)` and
stored as `{ iv, salt, tag, ciphertext }` (all base64-encoded).

Pros:
- Preserves full resumability.
- Uses Node 22's built-in `crypto` module — **zero new dependencies**.
- AES-256-GCM is NIST-standardized AEAD; authentication tag prevents silent
  corruption/tampering.
- scrypt (as opposed to PBKDF2 or bcrypt) is memory-hard, making brute-force
  attacks on the passphrase expensive.
- Passphrase can be re-used across runs; operator only needs to remember one
  secret.
- Threat model: even if the state file is exfiltrated, the attacker needs the
  passphrase to recover any PEM.

Cons / mitigations:
- Adds one UX step (passphrase prompt). Mitigated by prompting once per
  session (not per persona) and accepting passphrase via `AGENTIFY_SETUP_PASSPHRASE`
  env var for CI/automated runs.
- Weak passphrase weakens protection. Mitigated by documenting minimum length
  (≥12 chars) and rejecting empty passphrases in the prompt helper.
- If the operator loses the passphrase, they cannot resume. Same consequence
  as strip-and-re-enter if the file is lost — but the file still exists and
  can be deleted to start fresh with a new prefix.

**Verdict: accepted.**

### Memory-only (never persist PEM)

The PEM is held in process memory and never written to the checkpoint file.
On interrupt the PEM is lost with the process; on resume the same constraint
as strip-and-re-enter applies — 9× key rotation via the GitHub UI.
Implementation cost is low but the UX cost is identical to strip-and-re-enter.
**Verdict: rejected** for the same reasons.

### OS keychain (libsecret / Keychain Services / WCM)

PEMs are stored in the OS's native secret store (Linux: libsecret/GNOME
Keyring; macOS: Keychain Services; Windows: Windows Credential Manager).
This gives the best UX (no passphrase after unlock) and delegates key
protection to the OS.

Cons:
- Requires `keytar` or a similar native-module dependency with platform-native
  bindings — a significant increase in install complexity (native compilation
  at `npm install` time, optional deps for headless/CI environments, Electron
  vs. Node differences).
- The wizard targets Linux/macOS-first (path convention: `os.homedir() +
  ~/.config/agentify`); Windows support is out of scope for the initial
  implementation.  Adding libsecret/keytar still leaves Windows without
  coverage until explicitly handled.
- Headless/CI environments (docker, SSH sessions) often lack a running keyring
  daemon; the implementation must fall back gracefully or fail clearly.
- High implementation cost for a one-time bootstrap tool.

**Verdict: rejected** for this iteration.  The added platform complexity is
not justified given that the encrypt-at-rest strategy delivers equivalent
security guarantees with zero new dependencies.  OS-keychain support may be
revisited as a future enhancement once the wizard is stable.

---

## Concrete contract

### State schema changes

`PersonaCredsSchema` in `packages/setup/src/state.ts` will gain a union type
for the `pem` field, distinguishing plaintext (v1, legacy) from ciphertext
(v2):

```ts
// v1 (current — will be rejected on load after migration)
pem: z.string().min(1)

// v2
pem: z.union([
  z.string().min(1),           // plaintext — only during in-memory phase
  EncryptedValueSchema,        // on-disk form: { version, iv, salt, tag, ciphertext }
])
```

`EncryptedValueSchema`:
```ts
z.object({
  version: z.literal(2),
  iv:         z.string(),   // base64, 12 bytes
  salt:       z.string(),   // base64, 32 bytes
  tag:        z.string(),   // base64, 16 bytes
  ciphertext: z.string(),   // base64
})
```

A top-level `stateVersion: z.literal(2)` field will be added to
`WizardStateSchema` to allow load-time dispatch.

### Save path

`stateForSave(state, passphrase)` will encrypt every PEM in
`state.coordinator` and `state.personas[*]` before serialization, producing
`EncryptedValue` objects in place of the raw string.  The apps-phase
checkpoint in `packages/setup/src/driver/apps.ts` will be updated to call
`stateForSave` (closing the sanitization-bypass gap) and will receive the
session passphrase from the orchestrator.

### Load path

`loadState(path, passphrase)` will detect `stateVersion: 2` and decrypt each
`EncryptedValue` PEM field before returning the state to callers.  The
passphrase is accepted via:
1. `AGENTIFY_SETUP_PASSPHRASE` environment variable (CI/headless).
2. Interactive prompt (TTY) on wizard entry / resume.

### Resume behavior

On `wizard resume`, the operator is prompted for the passphrase immediately
after load-path validation.  If decryption fails (wrong passphrase), the
wizard prints a clear error and exits — it does not partially decrypt.

### Migration story for existing v1 state files

V1 state files lack `stateVersion` (or carry `stateVersion: 1`).  On load,
the wizard detects the absence of `stateVersion: 2` and:
1. Prompts the operator to supply a passphrase.
2. Decrypts/re-encrypts in place, writing a v2 state file.
3. Prints a migration notice explaining what changed.

If the operator has already completed the wizard (`.env` exists), they may
also simply delete the state file — migration is optional for completed runs.

### Policy generalization

The encrypt-at-rest policy **extends** to `clientSecret`, `webhookSecret`,
and `anthropic.oauth_token` via the same `EncryptedValueSchema` union.  The
`stateForSave` helper will accept an optional `sensitiveFields` list that
defaults to `['pem', 'clientSecret', 'webhookSecret', 'oauth_token']`.  This
is a natural extension of the existing `anthropic.value` stripping precedent.
The follow-up implementation plan should scope whether all four fields are
covered in the first pass or whether only `pem` ships first (lower risk to
unblock the immediate security gap).

### `verify` subcommand interaction

`runVerify` reads secrets from `.env`, not from the state file, so it is not
directly affected.  However, if the `verify` path ever needs to call
`loadState` (e.g. to cross-check a specific App ID), it must supply a
passphrase.  The ADR recommends that `verify` accept `AGENTIFY_SETUP_PASSPHRASE`
and prompt interactively if unset, consistent with the main wizard UX.

### Platform note

The implementation uses only `node:crypto` (AES-256-GCM, scrypt).  No
platform-specific APIs are required.  Windows is unsupported today for other
reasons (the `~/.config/agentify` path convention); this strategy does not
increase or decrease Windows compatibility.

---

## Follow-up

Implementation is tracked in issue #484 (`Plan: implement encrypt-at-rest for setup wizard PEMs (follow-up from #479)`).

---

*Signed 🎭 **The Conductor** · Engineering Lead*
