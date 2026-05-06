import { describe, it, expect } from 'vitest';
import { CoordinatorMetrics } from './metrics.js';

describe('CoordinatorMetrics', () => {
  describe('invalidRoutingLabelsTotal', () => {
    it('registers the counter in the local registry', () => {
      const m = new CoordinatorMetrics();
      expect(
        m.registry.getSingleMetric('agentify_coordinator_invalid_routing_labels_total'),
      ).toBeDefined();
    });

    it('increments with repo label via recordInvalidRoutingLabel', async () => {
      const m = new CoordinatorMetrics();
      m.recordInvalidRoutingLabel('acme/api');
      m.recordInvalidRoutingLabel('acme/api');
      m.recordInvalidRoutingLabel('other/repo');

      const text = await m.registry.metrics();
      // acme/api → 2
      expect(text).toMatch(
        /agentify_coordinator_invalid_routing_labels_total\{(?=[^}]*repo="acme\/api")[^}]*\} 2/,
      );
      // other/repo → 1
      expect(text).toMatch(
        /agentify_coordinator_invalid_routing_labels_total\{(?=[^}]*repo="other\/repo")[^}]*\} 1/,
      );
    });

    it('starts at zero — counter is not present until first increment', async () => {
      const m = new CoordinatorMetrics();
      const text = await m.registry.metrics();
      // Counter line with a value should not appear before any increment.
      expect(text).not.toMatch(/agentify_coordinator_invalid_routing_labels_total\{[^}]+\} \d/);
    });
  });

  describe('hijackAttemptsTotal', () => {
    it('registers the counter in the local registry', () => {
      const m = new CoordinatorMetrics();
      expect(
        m.registry.getSingleMetric('agentify_coordinator_hijack_attempts_total'),
      ).toBeDefined();
    });

    it('increments with repo and pattern labels via recordHijackAttempt', async () => {
      const m = new CoordinatorMetrics();
      m.recordHijackAttempt('acme/api', 'ignore-previous-instructions');
      m.recordHijackAttempt('acme/api', 'ignore-previous-instructions');
      m.recordHijackAttempt('acme/api', 'role-override');
      m.recordHijackAttempt('other/repo', 'system-xml-tag');

      const text = await m.registry.metrics();
      // acme/api + ignore-previous-instructions → 2
      expect(text).toMatch(
        /agentify_coordinator_hijack_attempts_total\{(?=[^}]*repo="acme\/api")(?=[^}]*pattern="ignore-previous-instructions")[^}]*\} 2/,
      );
      // acme/api + role-override → 1
      expect(text).toMatch(
        /agentify_coordinator_hijack_attempts_total\{(?=[^}]*repo="acme\/api")(?=[^}]*pattern="role-override")[^}]*\} 1/,
      );
      // other/repo + system-xml-tag → 1
      expect(text).toMatch(
        /agentify_coordinator_hijack_attempts_total\{(?=[^}]*repo="other\/repo")(?=[^}]*pattern="system-xml-tag")[^}]*\} 1/,
      );
    });

    it('starts at zero — counter is not present until first increment', async () => {
      const m = new CoordinatorMetrics();
      const text = await m.registry.metrics();
      expect(text).not.toMatch(/agentify_coordinator_hijack_attempts_total\{[^}]+\} \d/);
    });
  });

  describe('registry isolation', () => {
    it('each CoordinatorMetrics instance has its own registry', async () => {
      const m1 = new CoordinatorMetrics();
      const m2 = new CoordinatorMetrics();

      m1.recordInvalidRoutingLabel('acme/api');
      m1.recordHijackAttempt('acme/api', 'role-override');

      // m2 should not see m1's increments
      const text2 = await m2.registry.metrics();
      expect(text2).not.toMatch(/agentify_coordinator_invalid_routing_labels_total\{[^}]+\} \d/);
      expect(text2).not.toMatch(/agentify_coordinator_hijack_attempts_total\{[^}]+\} \d/);
    });
  });
});
