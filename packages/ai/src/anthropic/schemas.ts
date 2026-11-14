import { z } from 'zod';
import { COLOUR_PRESETS, SEGMENT_LABELS, STYLE_IDS, TRANSITION_TYPES } from '@studio/core';

/**
 * Structured-output schemas sent to the model. They mirror the field names and allowed values of the core
 * contracts but carry no numeric limits, literals or defaults. The SDK helper (zodOutputFormat in
 * @anthropic-ai/sdk 1.6.0) keeps only a JSON-schema subset and moves every other keyword, `enum` included, into
 * the field description; its Zod parse then rejects the whole reply when one value is off-list. So enum fields
 * are strings whose description lists the allowed values, and the checks happen afterwards: validateEditPlan for
 * plans (its errors go back to the model for repair) and normaliseLabels for shot labels. All fields are
 * required (nullable where absence is meaningful).
 */
function oneOf(values: readonly string[], description?: string) {
  return z.string().describe(`${description ? `${description}. ` : ''}One of: ${values.join(', ')}`);
}

export const FRAMING_VALUES = ['closeup', 'medium', 'wide', 'unknown'] as const;

const WireSegment = z.object({
  id: z.string().describe('Unique id such as "s1"'),
  assetId: z.string().describe('Id of the clip this segment is cut from (must be one of the listed assets)'),
  inSec: z.number().describe('Start, in seconds into the source clip'),
  outSec: z.number().describe('End, in seconds into the source clip (inside the shot it comes from)'),
  speed: z.number().describe('Playback speed, 1 = real time; 0.25–4'),
  framing: z.object({
    mode: oneOf(['centre', 'focus']),
    focusX: z.number().describe('0–1 horizontal centre of interest'),
    focusY: z.number().describe('0–1 vertical centre of interest'),
  }),
  zoom: z
    .object({ from: z.number().describe('Scale at segment start, 1–1.5'), to: z.number().describe('Scale at segment end, 1–1.5') })
    .nullable()
    .describe('Subtle push-in or pull-out, or null'),
  transitionIn: z
    .object({ type: oneOf(TRANSITION_TYPES), durationSec: z.number().describe('0.15–1.5 seconds') })
    .nullable()
    .describe('Transition from the previous segment; null = straight cut; must be null on the first segment'),
  role: oneOf(SEGMENT_LABELS, 'Label of the shot this segment comes from'),
  keepOriginalSound: z.boolean().describe('Mix in this clip’s own sound (only when the clip has audio)'),
});

const WireTextOverlay = z.object({
  id: z.string(),
  text: z.string().describe('At most 60 characters; honest, no claims'),
  startSec: z.number().describe('Output time in seconds'),
  endSec: z.number().describe('Output time in seconds'),
  placement: oneOf(['top', 'centre', 'lower']),
  style: oneOf(['headline', 'subtitle', 'label']),
  animation: oneOf(['none', 'fade', 'rise', 'pop']),
  emphasis: oneOf(['normal', 'accent']),
});

const WireCaption = z.object({
  text: z.string().describe('Copied word for word from the transcript, at most 120 characters'),
  startSec: z.number().describe('Output time in seconds'),
  endSec: z.number().describe('Output time in seconds'),
});

export const PlannerWireSchema = z.object({
  styleId: oneOf(STYLE_IDS),
  title: z.string().describe('At most 80 characters'),
  description: z.string().describe('At most 280 characters describing the edit that was actually planned'),
  rationale: z.string().describe('Short explanation of the editorial choices'),
  segments: z.array(WireSegment).describe('1–40 segments in playback order'),
  textOverlays: z.array(WireTextOverlay).describe('At most 12; never two in the same placement at the same time'),
  captions: z.array(WireCaption).describe('Empty unless transcript segments were provided'),
  audio: z.object({
    music: z
      .object({
        trackId: z.string(),
        startOffsetSec: z.number().describe('Where in the track playback starts'),
        volume: z.number().describe('0–1'),
        fadeInSec: z.number().describe('0–3'),
        fadeOutSec: z.number().describe('0–4'),
        duckUnderOriginal: z.boolean(),
      })
      .nullable()
      .describe('Null when no music was provided'),
    originalSound: z.object({ enabled: z.boolean(), volume: z.number().describe('0–1') }),
    beatAlignment: z
      .object({ bpm: z.number().nullable(), alignedCutTimesSec: z.array(z.number()) })
      .nullable()
      .describe('Output times of cuts placed on beats, or null without music'),
    loudnessTargetLufs: z.number().describe('Usually -14'),
  }),
  colourPreset: oneOf(COLOUR_PRESETS),
});
export type PlannerWire = z.infer<typeof PlannerWireSchema>;

export const LabelWireSchema = z.object({
  frames: z.array(
    z.object({
      shotId: z.string().describe('The shot id given next to the frame'),
      label: oneOf(SEGMENT_LABELS),
      confidence: z.number().describe('0–1'),
      description: z.string().describe('At most 20 words, plain description of what is visible'),
      framing: oneOf(FRAMING_VALUES),
      focus: z
        .object({ x: z.number().describe('0–1 from the left edge'), y: z.number().describe('0–1 from the top edge') })
        .nullable()
        .describe('Centre of the haircut or face, or null'),
      issues: z.array(z.string()).describe('Problems such as "blurry", "bad crop", "face cut off", "shaky"; empty if none'),
    }),
  ),
});
export type LabelWire = z.infer<typeof LabelWireSchema>;
