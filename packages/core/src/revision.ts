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
  /** Colour look asked for ("more natural colour", "punchier colours", "moodier", "brighter and cleaner"). */
  colour?: 'keep' | 'natural' | 'clean' | 'cinematic' | 'punchy';
  /** Cutting to the music's beat: "cut to the beat" (on) or "ignore the beat" (off). */
  beatSync?: 'keep' | 'on' | 'off';
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
  ['finished cut', 'result'],
  ['finished haircut', 'result'],
  ['finished product', 'result'],
  ['final look', 'result'],
  ['final cut', 'result'],
  ['end result', 'result'],
  ['transformation', 'result'],
  ['finished', 'result'],
  ['finish', 'result'],
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
    colour: 'keep',
    beatSync: 'keep',
    unparsed: [],
  };
  const sentences = instruction
    .split(/(?<=[.!?;])\s+|\n+|,\s*(?=(?:and|but|also)\b)/i)
    .map((s) => s.trim())
    .filter(Boolean);

  for (const raw of sentences) {
    const s = raw.toLowerCase();
    let understood = false;

    const seconds = readDurationSeconds(s);
    if (seconds !== null) {
      hints.targetDurationSec = seconds;
      understood = true;
    }
    if (hints.targetDurationSec === null && /\b(shorter|shorten|tighten|trim it|too long)\b/.test(s)) {
      hints.targetDurationSec = -1;
      understood = true;
    }
    if (hints.targetDurationSec === null && /\b(longer|extend|stretch|too short)\b/.test(s) && !/\b(hold|shots?)\b/.test(s)) {
      hints.targetDurationSec = -2;
      understood = true;
    }

    const colour = readColour(s);
    if (colour) {
      hints.colour = colour;
      understood = true;
    }
    if (/\b(?:ignore|forget|don'?t (?:follow|cut to)|stop cutting (?:to|on)|not on|off) the beats?\b|\bno beat[- ]?sync\b|\bnatural (?:cut|shot) lengths\b/.test(s)) {
      hints.beatSync = 'off';
      understood = true;
    } else if (/\b(?:cut|cuts|cutting|edit|sync|time|timed|match)\b[^.]*\b(?:to|on|with) the beats?\b|\bon the beat\b|\bbeat[- ]?sync(?:ed)?\b/.test(s)) {
      hints.beatSync = 'on';
      understood = true;
    }

    const mentionsTransitions = /\b(flashy|fancy|wipes?|slides?|transitions?|effects?|zooms?|spins?|whips?|glitch(es)?|flashes)\b/.test(s);
    if (mentionsTransitions && /\b(remove|no|without|drop|kill|lose|ditch|get rid of|less|fewer|tone down|calm down|simpler?|simple cuts|hard cuts|too much|cheesy|distracting|over the top)\b/.test(s)) {
      // Only a blanket request ("no transitions", "hard cuts only") removes every transition. Naming a kind of
      // effect ("no wipes") or calling it flashy keeps the gentle fades and dissolves.
      const blanket = /\b(transitions?|effects?)\b/.test(s) && !/\b(flashy|fancy|cheesy|over the top)\b/.test(s);
      hints.transitions = blanket && /\b(no|without|none|hard cuts|remove all|remove the|get rid of)\b/.test(s) ? 'none' : 'restrained';
      understood = true;
    } else if (/\b(hard|straight|plain|simple) cuts only\b|\bjust (hard |straight )?cuts\b|\bonly (hard |straight )?cuts\b/.test(s)) {
      hints.transitions = 'none';
      understood = true;
    } else if (!colour && /\b(?:keep|make) it (?:simple|clean|minimal|plain|understated|subtle|classic)\b|\b(?:simpler|cleaner|more minimal|less busy|too busy|too much going on|tone it down)\b/.test(s)) {
      hints.transitions = 'restrained';
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
      if (/\b(quieter|lower|softer|(?:turn|bring|take|knock|cut|dial|tone)(?:\s+[\w'’]+){0,3}\s+down|down a (?:bit|touch|notch)|too loud|too much|drowns?|drowning|overpower(?:s|ing)?|in the background)\b/.test(s)) hints.music = 'quieter';
      else if (/\b(louder|(?:turn|bring|dial)(?:\s+[\w'’]+){0,3}\s+up|pump(?:\s+[\w'’]+){0,3}\s+up|too quiet|too soft|can'?t hear|cannot hear)\b/.test(s)) hints.music = 'louder';
      else if (/\b(no|remove|without|mute|drop|lose|ditch|kill|get rid of|cut the)\b/.test(s)) hints.music = 'none';
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

    const more =
      s.match(/\b(?:more|longer|focus|emphasi[sz]e|show|highlight|feature|linger|dwell|stay|hold|spend|give)\b[^.]*?\b(?:of|on|to)\b\s+(?:the\s+)?([a-z\- ]+)/) ??
      s.match(/\b(?:more|show|linger on|dwell on)\b\s+(?:the\s+)?([a-z\- ]+)/);
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

/**
 * The colour look a sentence asks for, or null. "Cleaner" or "brighter" only count as colour when they describe the
 * look or the colour, so "keep it cleaner" still means simpler transitions.
 */
function readColour(s: string): RevisionHints['colour'] | null {
  if (/\b(?:more natural|natural(?:-looking)?) (?:colou?rs?|look|grade|tones?)\b|\bless (?:edited|filtered|graded)\b|\bno filter\b/.test(s)) return 'natural';
  if (/\bmoodier\b|\bmoody\b|\bcinematic\b|\bfilm(?:ic)? look\b/.test(s)) return 'cinematic';
  if (/\bmore contrast\b|\bpunch(?:y|ier) (?:colou?rs?|look|grade)\b|\bmore vivid\b|\bmore saturat\w*\b|\bmore colourful\b|\bcolou?rs? (?:pop|punchier)\b/.test(s)) return 'punchy';
  if (/\bbrighter and cleaner\b|\bcleaner and brighter\b|\b(?:clean|cleaner|brighter) (?:colou?rs?|look|grade)\b/.test(s)) return 'clean';
  return null;
}

const WORD_NUMBERS: Record<string, number> = {
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
  eleven: 11,
  twelve: 12,
  thirteen: 13,
  fourteen: 14,
  fifteen: 15,
  sixteen: 16,
  seventeen: 17,
  eighteen: 18,
  nineteen: 19,
  twenty: 20,
  'twenty-five': 25,
  'twenty five': 25,
  thirty: 30,
  'forty-five': 45,
  'forty five': 45,
  sixty: 60,
  ninety: 90,
};

/** Shortest and longest absolute lengths a revision may ask for, in seconds. */
const MIN_REQUESTED_SEC = 5;
const MAX_REQUESTED_SEC = 90;

function inRange(n: number): number | null {
  const rounded = Math.round(n);
  return Number.isFinite(rounded) && rounded >= MIN_REQUESTED_SEC && rounded <= MAX_REQUESTED_SEC ? rounded : null;
}

/**
 * Reads an absolute length from one lower-cased sentence: "15 seconds", "20s", "15 sec", "15-second",
 * "fifteen seconds", "half a minute", "a minute", "1.5 minutes", and a bare number after a length verb such as
 * "cut it to 15" or "keep it under 20". Returns null when no length between 5 and 90 seconds is stated.
 */
function readDurationSeconds(s: string): number | null {
  const unit = s.match(/\b(\d{1,3}(?:\.\d+)?)[\s-]*(?:s|sec|secs|second|seconds)\b/);
  if (unit) return inRange(Number(unit[1]));

  const wordNames = Object.keys(WORD_NUMBERS).sort((a, b) => b.length - a.length).join('|');
  const wordUnit = s.match(new RegExp(`\\b(${wordNames})[\\s-]*(?:sec|secs|second|seconds)\\b`));
  if (wordUnit) return inRange(WORD_NUMBERS[wordUnit[1] ?? ''] ?? NaN);

  if (/\bhalf (?:a|of a|one) minute\b|\bhalf-minute\b/.test(s)) return 30;
  if (/\b(?:a|one|1) minute and a half\b|\bminute and a half\b|\bone and a half minutes?\b/.test(s)) return 90;
  const minutes = s.match(/\b(\d(?:\.\d+)?)\s*(?:m|min|mins|minute|minutes)\b/);
  if (minutes) return inRange(Number(minutes[1]) * 60);
  if (/\b(?:a|one) (?:full )?minute\b/.test(s)) return 60;

  // A bare number only counts when a length verb leads to it, so "two shots" or "9:16" are never read as seconds.
  const bare = s.match(
    /\b(?:cut|trim|make|keep|get|bring|shorten|take|chop)\b[^\d.!?]*?\b(?:to|at|under|around|about|it|this|max(?:imum)?(?: of)?)\s+(\d{1,3})\b(?![:.]\d)(?!\s*(?:%|percent|x\b|times\b|shots?\b|clips?\b|cuts?\b|fps\b|frames?\b|px\b|bpm\b|of\b))/,
  );
  if (bare) return inRange(Number(bare[1]));
  const bareWord = s.match(new RegExp(`\\b(?:cut|trim|make|keep|get|bring|shorten|take|chop)\\b[^\\d]*?\\b(?:to|at|under|around|about)\\s+(${wordNames})\\b(?!\\s*(?:shots?|clips?|cuts?)\\b)`));
  if (bareWord) return inRange(WORD_NUMBERS[bareWord[1] ?? ''] ?? NaN);
  return null;
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
