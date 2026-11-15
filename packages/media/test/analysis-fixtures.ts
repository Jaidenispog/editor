/** The synthetic sample footage (generated on demand, safely in parallel) comes from ./sample-footage.ts. */
export { ensureSamples, hasFfmpeg, SAMPLE_FILES, samplePath, SAMPLES_DIR } from './sample-footage.js';

/** Deterministic pseudo-random values in [-0.5, 0.5) so synthetic test signals never flake. */
export function noiseSource(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 4294967296 - 0.5;
  };
}
