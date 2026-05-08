import type { ParsedSoul } from '@agenti-fy/shared';

/**
 * Mutable holder for the active SOUL. Replaces an earlier `Proxy({})` hack
 * that broke `Object.keys`, `in`, and JSON serialization. Consumers that
 * need the latest SOUL on each call (skill runner, worktree manager) hold
 * a `SoulRef` and read `.current` per-call.
 */
export class SoulRef {
  private _current: ParsedSoul;

  constructor(initial: ParsedSoul) {
    this._current = initial;
  }

  get current(): ParsedSoul {
    return this._current;
  }

  set(next: ParsedSoul): void {
    this._current = next;
  }
}
