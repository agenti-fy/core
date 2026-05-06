import { describe, it, expect } from 'vitest';
import { parseDependencies } from './dependencies.js';

describe('parseDependencies', () => {
  it('returns [] for an empty body', () => {
    expect(parseDependencies('')).toEqual([]);
    expect(parseDependencies('Some prose with no deps in it.')).toEqual([]);
  });

  it('parses a single "Depends on: #N"', () => {
    expect(parseDependencies('Depends on: #11')).toEqual([11]);
  });

  it('parses multiple comma-separated deps on one line', () => {
    expect(parseDependencies('Depends on: #11, #12, #13')).toEqual([11, 12, 13]);
  });

  it('parses "Blocked by", "Requires", "After"', () => {
    expect(parseDependencies('Blocked by: #5')).toEqual([5]);
    expect(parseDependencies('Requires #6')).toEqual([6]);
    expect(parseDependencies('After #7')).toEqual([7]);
    expect(parseDependencies('After: #8')).toEqual([8]);
  });

  it('handles markdown bold + list markers', () => {
    expect(parseDependencies('- **Depends on**: #11')).toEqual([11]);
    expect(parseDependencies('* *Blocked by* #12')).toEqual([12]);
  });

  it('is case-insensitive on the keyword', () => {
    expect(parseDependencies('DEPENDS ON: #11')).toEqual([11]);
    expect(parseDependencies('blocked BY: #12')).toEqual([12]);
  });

  it('dedupes and preserves declaration order', () => {
    expect(parseDependencies('Depends on: #11, #12\nBlocked by: #11, #13')).toEqual([
      11, 12, 13,
    ]);
  });

  it('handles both keyword + reference together with surrounding prose', () => {
    const body = `# Some Issue

Implement the foo widget.

## Dependencies
- **Depends on**: #11, #12 (data model + theme)
- **Blocked by**: nothing externally

## Notes
After #13 is merged, also revisit edge cases.
`;
    expect(parseDependencies(body)).toEqual([11, 12, 13]);
  });

  it('ignores keyword mentions without #N references', () => {
    expect(parseDependencies('This depends on the moon being in the right phase.')).toEqual(
      [],
    );
  });

  it('handles "Depends on: none" (legacy phrasing)', () => {
    expect(parseDependencies('Depends on: none')).toEqual([]);
  });

  it('does NOT match mid-sentence keyword usage in prose', () => {
    // Real regression from agenti-fy/core#193 — the body said
    // `the parent issue requires that "..." — so once #191's first subtask`
    // and parseDependencies wrongly extracted 191. Mid-sentence "requires"
    // / "depends on" / "after" must not anchor a dep declaration.
    const body =
      'The parent issue requires that the typecheck step works — once #191 ' +
      'lands we can revisit. After #2 was opened, we paused this work. ' +
      'This depends on #999 in spirit, not formally.\n';
    expect(parseDependencies(body)).toEqual([]);
  });

  it('does NOT confuse `Parent: #N` (issue-template metadata) with a dep', () => {
    expect(parseDependencies('Parent: #191\n\nimplementation notes')).toEqual([]);
  });

  it('still parses the canonical plan-template body correctly', () => {
    const body = `Parent: #191

## Context

The parent issue requires the typecheck step. Once #191 lands we revisit.

## Dependencies

Depends on: #192

## Notes

Misc.
`;
    expect(parseDependencies(body)).toEqual([192]);
  });
});
