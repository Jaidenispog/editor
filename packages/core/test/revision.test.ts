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

  describe('natural phrasings', () => {
    it('turns the music down', () => {
      for (const phrase of ['turn the music down', "music's too loud", 'The music’s too loud', 'bring the song down a bit', 'the track drowns out the clippers']) {
        const h = parseRevisionInstruction(phrase);
        expect(h.music, phrase).toBe('quieter');
        expect(h.unparsed, phrase).toEqual([]);
      }
    });
    it('turns the music up or removes it', () => {
      expect(parseRevisionInstruction('turn the music up').music).toBe('louder');
      expect(parseRevisionInstruction("I can't hear the song").music).toBe('louder');
      expect(parseRevisionInstruction('lose the music').music).toBe('none');
    });
    it('reads a bare number after a length verb', () => {
      expect(parseRevisionInstruction('cut it to 15').targetDurationSec).toBe(15);
      expect(parseRevisionInstruction('keep it under 20 please').targetDurationSec).toBe(20);
      expect(parseRevisionInstruction('make it 12').targetDurationSec).toBe(12);
      expect(parseRevisionInstruction('trim it down to twenty').targetDurationSec).toBe(20);
    });
    it('does not read shot counts or aspect ratios as a length', () => {
      expect(parseRevisionInstruction('cut it to 3 shots').targetDurationSec).toBeNull();
      expect(parseRevisionInstruction('keep it at 9:16').targetDurationSec).toBeNull();
      expect(parseRevisionInstruction('make it 2x faster').targetDurationSec).toBeNull();
    });
    it('reads short and spelled-out units', () => {
      expect(parseRevisionInstruction('15 sec').targetDurationSec).toBe(15);
      expect(parseRevisionInstruction('a 25-second version').targetDurationSec).toBe(25);
      expect(parseRevisionInstruction('make it fifteen seconds').targetDurationSec).toBe(15);
    });
    it('reads lengths in minutes', () => {
      expect(parseRevisionInstruction('half a minute').targetDurationSec).toBe(30);
      expect(parseRevisionInstruction('make it a minute').targetDurationSec).toBe(60);
      expect(parseRevisionInstruction('a minute and a half').targetDurationSec).toBe(90);
      expect(parseRevisionInstruction('1 min').targetDurationSec).toBe(60);
      expect(parseRevisionInstruction('make it 5 minutes').targetDurationSec).toBeNull();
    });
    it('drops wipes but keeps gentle fades', () => {
      const h = parseRevisionInstruction('no wipes');
      expect(h.transitions).toBe('restrained');
      expect(h.unparsed).toEqual([]);
      expect(parseRevisionInstruction('get rid of the zooms').transitions).toBe('restrained');
    });
    it('keeps it simple', () => {
      const h = parseRevisionInstruction('keep it simple');
      expect(h.transitions).toBe('restrained');
      expect(h.unparsed).toEqual([]);
      expect(parseRevisionInstruction('just cuts').transitions).toBe('none');
    });
    it('shows more of the line-up', () => {
      const h = parseRevisionInstruction('more of the line-up');
      expect(h.emphasiseLabels).toEqual(['fade_detail']);
      expect(h.unparsed).toEqual([]);
    });
    it('lingers on the reveal', () => {
      const h = parseRevisionInstruction('linger on the reveal');
      expect(h.emphasiseLabels).toEqual(['result']);
      expect(h.targetDurationSec).toBeNull();
      expect(h.unparsed).toEqual([]);
      expect(parseRevisionInstruction('spend more time on the fade').emphasiseLabels).toEqual(['fade_detail']);
    });
    it('starts with the finished cut', () => {
      const h = parseRevisionInstruction('start with the finished cut');
      expect(h.opening).toBe('result');
      expect(h.targetDurationSec).toBeNull();
      expect(h.unparsed).toEqual([]);
    });
    it('combines natural phrasings in one request', () => {
      const h = parseRevisionInstruction("Cut it to 15. The music's too loud. No wipes. Linger on the reveal.");
      expect(h.targetDurationSec).toBe(15);
      expect(h.music).toBe('quieter');
      expect(h.transitions).toBe('restrained');
      expect(h.emphasiseLabels).toEqual(['result']);
      expect(h.unparsed).toEqual([]);
    });
  });
});
