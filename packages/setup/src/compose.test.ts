import { describe, expect, it } from 'vitest';
import { BUILTIN_PERSONAS } from '@agenti-fy/shared';
import { renderCompose } from './compose.js';

describe('renderCompose', () => {
  it('pins both coordinator and agent images to the same registry + tag', () => {
    const out = renderCompose({ imageTag: '0.3.1' });
    expect(out).toContain('image: ghcr.io/agenti-fy/coordinator:0.3.1');
    expect(out).toContain('image: ghcr.io/agenti-fy/agent:0.3.1');
  });

  it('uses the operator-supplied registry when overridden', () => {
    const out = renderCompose({ imageRegistry: 'ghcr.io/myfork', imageTag: '0.3.1' });
    expect(out).toContain('image: ghcr.io/myfork/coordinator:0.3.1');
    expect(out).toContain('image: ghcr.io/myfork/agent:0.3.1');
    expect(out).not.toContain('ghcr.io/agenti-fy/');
  });

  it('strips a trailing slash on imageRegistry so the path joins cleanly', () => {
    const out = renderCompose({ imageRegistry: 'ghcr.io/agenti-fy/', imageTag: '0.3.1' });
    expect(out).toContain('image: ghcr.io/agenti-fy/coordinator:0.3.1');
    // Negative: no double slash.
    expect(out).not.toMatch(/agenti-fy\/\/coordinator/);
  });

  it('emits a service block for every built-in persona', () => {
    const out = renderCompose({ imageTag: '0.3.1' });
    for (const persona of BUILTIN_PERSONAS) {
      expect(out, `service block for ${persona}`).toMatch(new RegExp(`^\\s{2}${persona}:`, 'm'));
    }
  });

  it('does NOT include a build: stanza anywhere — published images only', () => {
    const out = renderCompose({ imageTag: '0.3.1' });
    expect(out).not.toContain('build:');
    expect(out).not.toContain('dockerfile:');
  });

  it('points each persona at its baked-in soul via SOUL_PATH (no host bind-mount)', () => {
    // Earlier versions bind-mounted `./souls/<persona>.md` from the host into
    // each container at `/etc/agentify/SOUL.md`. macOS Sonoma+ attaches the
    // sticky `com.apple.provenance` xattr to Node-written files, which Docker
    // Desktop's virtiofs layer rejects with EPERM on `open(2)` — agents
    // couldn't read the file regardless of mode. The wizard now sets
    // SOUL_PATH per persona to the agent image's baked-in copy at
    // `/app/souls/<persona>.md`, sidestepping the bind mount entirely.
    const out = renderCompose({ imageTag: '0.3.1' });
    for (const persona of BUILTIN_PERSONAS) {
      expect(out, `SOUL_PATH for ${persona}`).toContain(
        `SOUL_PATH: /app/souls/${persona}.md`,
      );
      // Negative: the old bind-mount line MUST NOT come back. If a future
      // edit re-introduces it, the EPERM regression returns.
      expect(out, `no soul bind-mount for ${persona}`).not.toContain(
        `./souls/${persona}.md:/etc/agentify/SOUL.md`,
      );
    }
  });

  it('emits per-persona workspace + claude volumes for every built-in persona', () => {
    const out = renderCompose({ imageTag: '0.3.1' });
    for (const persona of BUILTIN_PERSONAS) {
      // Volume reference inside the service block.
      expect(out, `workspace mount for ${persona}`).toContain(`${persona}-workspace:/workspaces`);
      expect(out, `claude store mount for ${persona}`).toContain(`${persona}-claude:/app/.claude`);
      // Top-level volume declaration.
      expect(out, `volume decl for ${persona}-workspace`).toMatch(
        new RegExp(`^\\s{2}${persona}-workspace:\\s*$`, 'm'),
      );
      expect(out, `volume decl for ${persona}-claude`).toMatch(
        new RegExp(`^\\s{2}${persona}-claude:\\s*$`, 'm'),
      );
    }
  });

  it('uses the per-persona env-var prefix in uppercase form', () => {
    const out = renderCompose({ imageTag: '0.3.1' });
    for (const persona of BUILTIN_PERSONAS) {
      const upper = persona.toUpperCase();
      expect(out, `${persona} App ID env`).toContain(`\${${upper}_GITHUB_APP_ID}`);
      expect(out, `${persona} install env`).toContain(`\${${upper}_GITHUB_APP_INSTALLATION_ID}`);
      expect(out, `${persona} pem env`).toContain(`\${${upper}_GITHUB_APP_PRIVATE_KEY}`);
    }
  });

  it('always emits the monitoring block, gated by the `monitoring` profile', () => {
    // Earlier versions had an `includeMonitoring` opt-in flag that defaulted
    // to false — so the wizard-generated compose never carried Prometheus +
    // Grafana, even though `docker compose --profile monitoring up` is the
    // standard opt-in idiom that should work out of the box. The flag is
    // gone; the block is always present, the `profiles: [monitoring]` gate
    // keeps it inert until the operator opts in at runtime.
    const out = renderCompose({ imageTag: '0.3.1' });
    expect(out).toContain('prom/prometheus:latest');
    expect(out).toContain('grafana/grafana:latest');
    // The profile gate is what makes "always emit" safe.
    expect(out).toMatch(/profiles:\s*\n\s*-\s*monitoring/);
    // Top-level volumes block carries the prometheus + grafana data volumes.
    expect(out).toMatch(/^\s{2}prometheus-data:\s*$/m);
    expect(out).toMatch(/^\s{2}grafana-data:\s*$/m);
  });

  it('monitoring services are NOT in the default-up service set', () => {
    // Defense-in-depth check: every monitoring service block carries the
    // `profiles:` field. A future edit that forgets the gate would surface
    // here — running `docker compose up` would suddenly pull Prometheus +
    // Grafana, which is never what an operator wants by default.
    const out = renderCompose({ imageTag: '0.3.1' });
    // Locate the prometheus block and verify the next `profiles:` line
    // appears within it (i.e. the block has the gate).
    const prometheusIdx = out.indexOf('prom/prometheus:latest');
    const grafanaIdx = out.indexOf('grafana/grafana:latest');
    expect(prometheusIdx).toBeGreaterThan(0);
    expect(grafanaIdx).toBeGreaterThan(prometheusIdx);
    // Both services must have a `profiles:\n  - monitoring` after their
    // image: line — slice from each image: line to the end of the doc and
    // confirm the gate appears before any other top-level construct.
    const prometheusBlock = out.slice(prometheusIdx, grafanaIdx);
    const grafanaBlock = out.slice(grafanaIdx);
    expect(prometheusBlock).toMatch(/profiles:\s*\n\s*-\s*monitoring/);
    expect(grafanaBlock).toMatch(/profiles:\s*\n\s*-\s*monitoring/);
  });

  it('declares the coordinator-data volume', () => {
    const out = renderCompose({ imageTag: '0.3.1' });
    expect(out).toMatch(/^volumes:\s*$/m);
    expect(out).toMatch(/^\s{2}coordinator-data:\s*$/m);
  });

  it('preserves the in-tree env-var defaults verbatim (compose.yml parity)', () => {
    const out = renderCompose({ imageTag: '0.3.1' });
    // Spot-check the load-bearing defaults that operators tune via .env.
    expect(out).toContain('CLAUDE_TIMEOUT_MS: ${CLAUDE_TIMEOUT_MS:-900000}');
    expect(out).toContain('CLAUDE_COST_LIMIT_USD: ${CLAUDE_COST_LIMIT_USD:-5.0}');
    expect(out).toContain('KB_ENABLED: ${KB_ENABLED:-true}');
    expect(out).toContain('MAX_RESULT_JSON_BYTES: ${MAX_RESULT_JSON_BYTES:-262144}');
    expect(out).toContain('PORT: ${COORDINATOR_PORT:-8080}');
  });

  it('output is byte-deterministic given the same inputs', () => {
    const a = renderCompose({ imageTag: '0.3.1' });
    const b = renderCompose({ imageTag: '0.3.1' });
    expect(a).toBe(b);
  });

  it('output ends with a single trailing newline (no double-newline tail)', () => {
    const out = renderCompose({ imageTag: '0.3.1' });
    expect(out.endsWith('\n')).toBe(true);
    expect(out.endsWith('\n\n')).toBe(false);
  });

  it('every service under `services:` is indented at column 2 (no col-0 services)', () => {
    // v0.3.1's first cut had `coordinator:` flush-left while every persona
    // was at column 2, which docker compose rejected with
    // "yaml: line 17: did not find expected key" (mismatched mapping
    // indentation under `services:`). This test locks the fix in: every
    // top-level service key MUST start with two spaces.
    const out = renderCompose({ imageTag: '0.3.1' });

    // Find the `services:` line and the next top-level (col-0) line after it.
    const lines = out.split('\n');
    const servicesIdx = lines.findIndex((l) => l === 'services:');
    expect(servicesIdx).toBeGreaterThanOrEqual(0);

    // Walk forward until we hit a column-0 non-blank line (end of services
    // block). Every non-blank line before that whose first character is the
    // start of a service key (matches /^\S/) is the bug we're guarding against.
    for (let i = servicesIdx + 1; i < lines.length; i++) {
      const line = lines[i] ?? '';
      if (line === '') continue;
      // Hit the next top-level section (volumes:, etc.)?
      if (/^[a-z]/.test(line)) break;
      // Anything inside services: must start with at least one space.
      expect(line, `line ${i + 1} inside services: starts at col 0: ${JSON.stringify(line)}`).toMatch(
        /^ /,
      );
    }

    // Spot-check the canonical pair that broke originally.
    expect(out).toMatch(/^\s{2}coordinator:/m);
    expect(out).toMatch(/^\s{2}orchestrator:/m);
  });
});
