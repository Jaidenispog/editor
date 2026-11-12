import { describe, expect, it } from 'vitest';
import { parseRevisionInstruction } from '../src/revision.js';

describe('parseRevisionInstruction', () => {
  it('reads an absolute duration', () => {
    expect(parseRevisionInstruction('make this 15 seconds').targetDurationSec).toBe(15);
    expect(parseRevisionInstruction('Cut it down to 20s please').targetDurationSec).toBe(20);
  });
  it('reads emphasis on the fade', () => {
    const h = parseRevisionInstruction('show more of the fade');
    expect(h.emphasiseLabels).toEqual(['fade_detail']);
    expect(h.unparsed).toEqual([]);
  });
  it('removes flashy transitions', () => {
    const h = parseRevisionInstruction('remove the flashy transitions');
    expect(h.transitions).toBe('restrained');
    expect(parseRevisionInstruction('no transitions, hard cuts only').transitions).toBe('none');
  });
  it('handles several requests in one instruction', () => {
    const h = parseRevisionInstruction('Make it 12 seconds. Less text and quieter music. Start with the before shot.');
    expect(h.targetDurationSec).toBe(12);
    expect(h.text).toBe('less');
    expect(h.music).toBe('quieter');
    expect(h.opening).toBe('before');
  });
  it('keeps unknown sentences for the AI planner', () => {
    const h = parseRevisionInstruction('Give it a warmer feel like a summer afternoon');
    expect(h.unparsed.length).toBe(1);
  });
  it('understands pacing and original sound', () => {
    const h = parseRevisionInstruction('make it faster and keep the clipper sound');
    expect(h.pacing).toBe('faster');
    expect(h.originalSound).toBe('on');
  });
});
