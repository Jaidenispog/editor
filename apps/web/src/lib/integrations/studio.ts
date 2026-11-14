import type { IntegrationStatus } from '../shared/integration-types.js';
import { envSentence, missingEnv, type IntegrationBuilder } from './types.js';

/** Video Studio services: AI planning and vision, speech captions, and media storage (Stage A wording). */
export const buildStudioIntegrations: IntegrationBuilder = (env) => {
  const out: IntegrationStatus[] = [];

  // --- AI planning and vision
  const aiMissing = env.AI_PROVIDER === 'anthropic' ? missingEnv(env, ['ANTHROPIC_API_KEY']) : ['AI_PROVIDER', ...missingEnv(env, ['ANTHROPIC_API_KEY'])];
  const aiOn = env.AI_PROVIDER === 'anthropic' && aiMissing.length === 0;
  out.push({
    id: 'ai',
    name: 'AI edit planning and shot recognition',
    areas: ['video'],
    configured: aiOn,
    connected: aiOn,
    missingEnv: aiOn ? [] : aiMissing,
    message: aiOn
      ? 'AI planning is on. Clips are described by the vision model and edits are planned with it; every plan is still checked against your footage before rendering.'
      : 'Edits are planned by the built-in rules planner, which works without any account. To add AI planning, set AI_PROVIDER=anthropic and ANTHROPIC_API_KEY on the server. Until then, tag Before, Result and Reaction clips by hand to unlock those styles.',
    ...(aiOn ? { detail: `Planner: ${env.AI_PLANNER_MODEL} · Vision: ${env.AI_VISION_MODEL}` } : {}),
    state: aiOn ? 'connected' : 'not_configured',
    liveMode: aiOn ? 'live' : null,
    verified: false,
  });

  // --- Transcription (captions). Deepgram is the recommended provider; OpenAI whisper-1 stays optional until
  // OpenAI shuts it down on 26 February 2027.
  const trProvider = env.TRANSCRIPTION_PROVIDER;
  const trMissing =
    trProvider === 'deepgram'
      ? missingEnv(env, ['DEEPGRAM_API_KEY'])
      : trProvider === 'openai'
        ? missingEnv(env, ['OPENAI_API_KEY'])
        : ['TRANSCRIPTION_PROVIDER', ...missingEnv(env, ['DEEPGRAM_API_KEY'])];
  const trOn = trProvider !== 'none' && trMissing.length === 0;
  const trName = trProvider === 'openai' ? 'OpenAI' : 'Deepgram';
  out.push({
    id: 'transcription',
    name: trProvider === 'none' ? 'Speech captions' : `Speech captions (${trName})`,
    areas: ['video'],
    configured: trOn,
    connected: trOn,
    missingEnv: trOn ? [] : trMissing,
    message: trOn
      ? trProvider === 'openai'
        ? 'Speech in your clips is transcribed by OpenAI so captions use the exact words spoken. OpenAI is retiring this model on 26 February 2027, so switch to Deepgram before then.'
        : 'Speech in your clips is transcribed by Deepgram so captions use the exact words spoken, timed to when they were said.'
      : trProvider === 'none'
        ? 'Captions are switched off because no transcription service is set up. Set TRANSCRIPTION_PROVIDER=deepgram and DEEPGRAM_API_KEY on the server to caption spoken words. Edits never show invented dialogue.'
        : `Captions are switched off because ${envSentence(trMissing)} is missing on the server. Edits never show invented dialogue.`,
    ...(trOn ? { detail: `Model: ${trProvider === 'openai' ? env.OPENAI_TRANSCRIPTION_MODEL : env.DEEPGRAM_MODEL}` } : {}),
    state: trOn ? 'connected' : 'not_configured',
    liveMode: trOn ? 'live' : null,
    verified: false,
  });

  // --- Storage
  const s3Missing = env.STORAGE_DRIVER === 's3' ? missingEnv(env, ['S3_BUCKET', 'S3_ACCESS_KEY_ID', 'S3_SECRET_ACCESS_KEY']) : [];
  out.push({
    id: 'storage',
    name: env.STORAGE_DRIVER === 's3' ? 'Cloud storage (S3-compatible)' : 'Local disk storage',
    areas: ['storage'],
    configured: s3Missing.length === 0,
    connected: s3Missing.length === 0,
    missingEnv: s3Missing,
    message:
      env.STORAGE_DRIVER === 's3'
        ? s3Missing.length === 0
          ? 'Videos are stored in a private cloud bucket. Browsers only receive links that expire.'
          : `Cloud storage is selected but ${envSentence(s3Missing)} ${s3Missing.length === 1 ? 'is' : 'are'} missing.`
        : 'Videos are stored on this server’s disk. Fine for one machine; switch to cloud storage (STORAGE_DRIVER=s3) before hosting in the cloud.',
    ...(env.STORAGE_DRIVER === 's3' && env.S3_ENDPOINT ? { detail: `Endpoint: ${new URL(env.S3_ENDPOINT).host}` } : {}),
    state: s3Missing.length === 0 ? 'connected' : 'not_configured',
    liveMode: null,
    verified: false,
  });

  return out;
};
