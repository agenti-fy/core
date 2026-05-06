export interface HijackDetectResult {
  hit: boolean;
  matched?: string[];
}

interface DetectionPattern {
  name: string;
  re: RegExp;
}

// No `g` flag on any pattern — using `g` with `RegExp.prototype.test` advances
// `lastIndex` and produces incorrect results on repeated calls.
const PATTERNS: DetectionPattern[] = [
  {
    name: 'ignore-previous-instructions',
    // "ignore all/the/previous/above instructions/rules/prompt"
    // \s{0,10} tolerates extra whitespace between words.
    re: /\bignore\s{0,10}(?:all|the|previous|above)\s{0,10}(?:instructions|rules|prompt)\b/i,
  },
  {
    name: 'role-override',
    // "you are/you're now/actually a/an <role>"
    re: /\byou(?:'re|\s{0,5}are)\s{0,10}(?:now|actually)\s{0,10}(?:a|an)\b/i,
  },
  {
    name: 'system-colon-line-start',
    // "system:" or "system prompt:" at the very start of a line (case-insensitive).
    // \b after "system" prevents false positives like "systemic:".
    re: /^system\b\s{0,10}(?:prompt\b\s{0,10})?:/im,
  },
  {
    name: 'system-xml-tag',
    // <system> and </system> XML-style injection tags.
    re: /<\/?system>/i,
  },
  {
    name: 'disregard-forget-instructions',
    // "disregard" or "forget" within 60 non-newline chars of instructions/rules/prompt.
    // Bounded quantifier prevents catastrophic backtracking.
    re: /\b(?:disregard|forget)\b[^\n]{0,60}\b(?:instructions|rules|prompt)\b/i,
  },
  {
    name: 'fenced-system-block',
    // ```system fenced code blocks at line start (markdown injection vector).
    re: /^```\s{0,5}system\b/im,
  },
];

export function detectHijackAttempt(text: string): HijackDetectResult {
  const matched: string[] = [];
  for (const { name, re } of PATTERNS) {
    if (re.test(text)) {
      matched.push(name);
    }
  }
  return matched.length > 0 ? { hit: true, matched } : { hit: false };
}
