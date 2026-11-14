import { describe, expect, it } from 'vitest';
import { parseRevisionInstruction } from '../src/revision.js';

describe('parseRevisionInstruction: colour and beat phrases', () => {
  it.each([
    ['More natural colour please', 'natural'],
    ['Less filtered', 'natural'],
    ['Punchier colours', 'punchy'],
    ['More contrast', 'punchy'],
    ['Make it moodier', 'cinematic'],
    ['Give it a cinematic look', 'cinematic'],
    ['Brighter and cleaner', 'clean'],
    ['Cleaner look', 'clean'],
  ])('%s → %s', (text, colour) => {
    const h = parseRevisionInstruction(text);
    expect(h.colour).toBe(colour);
    expect(h.unparsed).toEqual([]);
  });

  it('does not treat a cleaner look as a request about transitions', () => {
    expect(parseRevisionInstruction('Brighter and cleaner').transitions).toBe('keep');
    expect(parseRevisionInstruction('Keep it cleaner').transitions).toBe('restrained');
    expect(parseRevisionInstruction('Keep it cleaner').colour).toBe('keep');
  });

  it('reads beat requests', () => {
    expect(parseRevisionInstruction('Cut to the beat').beatSync).toBe('on');
    expect(parseRevisionInstruction('Time the cuts with the beat of the song').beatSync).toBe('on');
    expect(parseRevisionInstruction('Ignore the beat').beatSync).toBe('off');
    expect(parseRevisionInstruction("Don't cut to the beat").beatSync).toBe('off');
    expect(parseRevisionInstruction('Show more of the fade').beatSync).toBe('keep');
    expect(parseRevisionInstruction('Show more of the fade').colour).toBe('keep');
  });

  it('keeps the earlier readings of mixed requests', () => {
    const h = parseRevisionInstruction('Make it 15 seconds. Cut to the beat. Moodier.');
    expect(h.targetDurationSec).toBe(15);
    expect(h.beatSync).toBe('on');
    expect(h.colour).toBe('cinematic');
  });
});
