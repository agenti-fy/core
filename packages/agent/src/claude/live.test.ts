import { describe, it, expect } from 'vitest';
import pino from 'pino';
import { __test } from './live.js';

const { extractArtifacts } = __test;
const silentLog = pino({ level: 'silent' });

describe('extractArtifacts', () => {
  it('parses bare JSON object as the slot contents', () => {
    const out = extractArtifacts('plan', '{"child_issues":[101,102,103]}', silentLog);
    expect(out).toEqual({ plan: { child_issues: [101, 102, 103] } });
  });

  it('extracts JSON from a fenced ```json block, last block wins', () => {
    const text = [
      "Here's a draft:",
      '```json',
      '{ "child_issues": [1] }',
      '```',
      'Actually, on second thought:',
      '```json',
      '{ "child_issues": [2, 3] }',
      '```',
    ].join('\n');
    const out = extractArtifacts('plan', text, silentLog);
    expect(out).toEqual({ plan: { child_issues: [2, 3] } });
  });

  it('extracts JSON from an unlabelled fenced code block', () => {
    const text = ['Done.', '```', '{ "merged": true, "closed_issue": 7 }', '```'].join('\n');
    const out = extractArtifacts('merge', text, silentLog);
    expect(out).toEqual({ merge: { merged: true, closed_issue: 7 } });
  });

  it('extracts the trailing balanced {...} when the JSON sits inside prose', () => {
    const text =
      'I created issues #11 and #12 as planned.\n\n' +
      'Output: { "child_issues": [11, 12] }';
    const out = extractArtifacts('plan', text, silentLog);
    expect(out).toEqual({ plan: { child_issues: [11, 12] } });
  });

  it('returns {} when the model produced unrelated prose', () => {
    const out = extractArtifacts('plan', 'Sorry, I could not complete this task.', silentLog);
    expect(out).toEqual({});
  });

  it('returns {} when the JSON does not match the schema (e.g. wrong types)', () => {
    const out = extractArtifacts('plan', '{ "child_issues": ["not-a-number"] }', silentLog);
    expect(out).toEqual({});
  });

  it('returns {} on completely empty final text', () => {
    expect(extractArtifacts('plan', '', silentLog)).toEqual({});
    expect(extractArtifacts('plan', '   \n\n  ', silentLog)).toEqual({});
  });

  it('parses each method slot correctly', () => {
    expect(
      extractArtifacts('implement', '{"branch":"feat/foo/1-bar","pr_number":42}', silentLog),
    ).toEqual({ implement: { branch: 'feat/foo/1-bar', pr_number: 42 } });

    expect(
      extractArtifacts('review', '{"review_id":99,"verdict":"approved"}', silentLog),
    ).toEqual({ review: { review_id: 99, verdict: 'approved' } });

    expect(
      extractArtifacts('address_review', '{"commits_pushed":2,"rerequested":true}', silentLog),
    ).toEqual({ address_review: { commits_pushed: 2, rerequested: true } });

    expect(
      extractArtifacts('merge', '{"merged":true}', silentLog),
    ).toEqual({ merge: { merged: true } });
  });

  it('tolerates extra unknown fields when validating', () => {
    // The schema strips unknowns by default; we accept the JSON and keep only
    // known fields.
    const out = extractArtifacts(
      'plan',
      '{ "child_issues": [1,2], "notes": "ignored" }',
      silentLog,
    );
    expect(out).toEqual({ plan: { child_issues: [1, 2] } });
  });
});
