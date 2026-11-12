import { RESTRAINED_TRANSITIONS, type SegmentLabel, type TransitionType } from './styles.js';

export interface RevisionHints {
  /** Absolute seconds, or the sentinels -1 (shorter) / -2 (longer) for relative requests. */
  targetDurationSec: number | null;
  emphasiseLabels: SegmentLabel[];
  deemphasiseLabels: SegmentLabel[];
  transitions: 'keep' | 'restrained' | 'none';
  pacing: 'keep' | 'faster' | 'slower';
  text: 'keep' | 'less' | 'none' | 'more';
  music: 'keep' | 'quieter' | 'louder' | 'none';
  originalSound: 'keep' | 'on' | 'off';
  opening: SegmentLabel | null;
  /** Sentences the rules-based parser could not interpret (passed to the AI planner verbatim). */
  unparsed: string[];
}

const LABEL_WORDS: Array<[string, SegmentLabel]> = [
  ['line up', 'fade_detail'],
  ['line-up', 'fade_detail'],
  ['lineup', 'fade_detail'],
  ['fades', 'fade_detail'],
  ['fade', 'fade_detail'],
  ['taper', 'fade_detail'],
  ['edges', 'fade_detail'],
  ['edge', 'fade_detail'],
  ['details', 'fade_detail'],
  ['detail', 'fade_detail'],
  ['before', 'before'],
  ['finished look', 'result'],
  ['final look', 'result'],
  ['after', 'result'],
  ['result', 'result'],
  ['reveal', 'result'],
  ['reactions', 'reaction'],
  ['reaction', 'reaction'],
  ['smile', 'reaction'],
  ['cutting', 'cutting'],
  ['clippers', 'cutting'],
  ['clipper', 'cutting'],
  ['scissors', 'cutting'],
  ['process', 'cutting'],
  ['styling', 'styling'],
  ['blow dry', 'styling'],
  ['product', 'styling'],
  ['shop', 'environment'],
  ['studio', 'environment'],
];

/**
 * Deterministic interpretation of plain-English revision requests. The AI planner receives the raw
 * instruction as well; these hints make the rules-based fallback useful and let the validator
 * enforce hard constraints such as "no flashy transitions" and "make this 15 seconds".
 */
export function parseRevisionInstruction(instruction: string): RevisionHints {
  const hints: RevisionHints = {
    targetDurationSec: null,
    emphasiseLabels: [],
    deemphasiseLabels: [],
    transitions: 'keep',
    pacing: 'keep',
    text: 'keep',
    music: 'keep',
    originalSound: 'keep',
    opening: null,
    unparsed: [],
  };
  const sentences = instruction
    .split(/(?<=[.!?;])\s+|\n+|,\s*(?=(?:and|but|also)\b)/i)
    .map((s) => s.trim())
    .filter(Boolean);

  for (const raw of sentences) {
    const s = raw.toLowerCase();
    let understood = false;

    const dur = s.match(/(\d{1,3})\s*(?:s\b|sec\b|secs\b|second|seconds)/);
    if (dur) {
      const n = Number(dur[1]);
      if (n >= 5 && n <= 90) {
        hints.targetDurationSec = n;
        understood = true;
      }
    }
    if (hints.targetDurationSec === null && /\b(shorter|shorten|tighten|trim it|too long)\b/.test(s)) {
      hints.targetDurationSec = -1;
      understood = true;
    }
    if (hints.targetDurationSec === null && /\b(longer|extend|stretch|too short)\b/.test(s) && !/\b(hold|shots?)\b/.test(s)) {
      hints.targetDurationSec = -2;
      understood = true;
    }

    const mentionsTransitions = /\b(flashy|fancy|wipes?|slides?|transitions?|effects?|zooms?)\b/.test(s);
    if (mentionsTransitions && /\b(remove|no|without|drop|kill|less|fewer|tone down|calm down|simpler?|simple cuts|hard cuts|too much|cheesy|distracting)\b/.test(s)) {
      hints.transitions = /\b(no|without|none|hard cuts|remove all|remove the)\b/.test(s) && !/\b(flashy|fancy)\b/.test(s) ? 'none' : 'restrained';
      understood = true;
    }

    if (/\b(faster|quicker|snappier|more energy|punchier|speed (it )?up)\b/.test(s)) {
      hints.pacing = 'faster';
      understood = true;
    } else if (/\b(slower|calmer|relax(ed)?|breathe|slow (it )?down|less frantic|hold (the )?shots? longer)\b/.test(s)) {
      hints.pacing = 'slower';
      understood = true;
    }

    if (/\b(text|titles?|words|captions?)\b/.test(s)) {
      if (/\b(no|remove|without|drop)\b/.test(s)) hints.text = 'none';
      else if (/\b(less|fewer|smaller)\b/.test(s)) hints.text = 'less';
      else if (/\b(more|add|bigger)\b/.test(s)) hints.text = 'more';
      if (hints.text !== 'keep') understood = true;
    }

    if (/\b(music|song|track|soundtrack)\b/.test(s)) {
      if (/\b(quieter|lower|softer|turn down|too loud)\b/.test(s)) hints.music = 'quieter';
      else if (/\b(louder|turn up|too quiet)\b/.test(s)) hints.music = 'louder';
      else if (/\b(no|remove|without|mute|drop)\b/.test(s)) hints.music = 'none';
      if (hints.music !== 'keep') understood = true;
    }
    if (/\b(original|natural|clipper|real)\b.*\b(sound|audio)\b/.test(s)) {
      hints.originalSound = /\b(no|remove|without|mute|drop)\b/.test(s) ? 'off' : 'on';
      understood = true;
    }

    const startMatch = s.match(/\b(?:start|open|begin)\b.*?\b(?:with|on)\b\s+(?:the\s+)?([a-z\- ]+)/);
    if (startMatch) {
      const label = findLabel(startMatch[1] ?? '');
      if (label) {
        hints.opening = label;
        understood = true;
      }
    }

    const more = s.match(/\b(?:more|longer|focus|emphasi[sz]e|show|highlight|feature)\b[^.]*?\b(?:of|on)\b\s+(?:the\s+)?([a-z\- ]+)/) ?? s.match(/\b(?:more|show)\b\s+(?:the\s+)?([a-z\- ]+)/);
    if (more) {
      const label = findLabel(more[1] ?? '');
      if (label && !hints.emphasiseLabels.includes(label)) {
        hints.emphasiseLabels.push(label);
        understood = true;
      }
    }
    const less = s.match(/\b(?:less|fewer|cut down on)\b\s+(?:of\s+)?(?:the\s+)?([a-z\- ]+)/);
    if (less && !/\b(text|titles?|transitions?|music|effects?)\b/.test(less[1] ?? '')) {
      const label = findLabel(less[1] ?? '');
      if (label && !hints.deemphasiseLabels.includes(label)) {
        hints.deemphasiseLabels.push(label);
        understood = true;
      }
    }

    if (!understood) hints.unparsed.push(raw);
  }
  return hints;
}

function findLabel(phrase: string): SegmentLabel | null {
  const p = phrase.toLowerCase().trim();
  for (const [word, label] of LABEL_WORDS) {
    const escaped = word.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&');
    if (new RegExp(`\\b${escaped}\\b`).test(p)) return label;
  }
  return null;
}

export function transitionsAllowedByHints(hints: RevisionHints): readonly TransitionType[] | null {
  if (hints.transitions === 'none') return [];
  if (hints.transitions === 'restrained') return RESTRAINED_TRANSITIONS;
  return null;
}
