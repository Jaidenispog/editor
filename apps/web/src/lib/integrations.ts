import 'server-only';
import type { Env } from '@studio/config';
import { schema } from '@studio/db';
import { getDb } from './db.js';
import { getEnv } from './env.js';
import type { IntegrationStatus } from './shared/integration-types.js';

export type { IntegrationStatus, IntegrationArea } from './shared/integration-types.js';

/** Minimal connection facts read from integration_connections and social_accounts. */
export interface ConnectionFacts {
  connections: Array<{ provider: string; status: string; displayName: string }>;
  socialAccounts: Array<{ platform: string; status: string; username: string }>;
}

type EnvLike = Pick<
  Env,
  | 'AI_PROVIDER'
  | 'ANTHROPIC_API_KEY'
  | 'AI_PLANNER_MODEL'
  | 'AI_VISION_MODEL'
  | 'TRANSCRIPTION_PROVIDER'
  | 'OPENAI_API_KEY'
  | 'OPENAI_TRANSCRIPTION_MODEL'
  | 'STORAGE_DRIVER'
  | 'S3_BUCKET'
  | 'S3_ACCESS_KEY_ID'
  | 'S3_SECRET_ACCESS_KEY'
  | 'S3_ENDPOINT'
  | 'META_APP_ID'
  | 'META_APP_SECRET'
  | 'TIKTOK_CLIENT_KEY'
  | 'TIKTOK_CLIENT_SECRET'
  | 'SQUARE_APPLICATION_ID'
  | 'SQUARE_APPLICATION_SECRET'
  | 'SQUARE_WEBHOOK_SIGNATURE_KEY'
  | 'RESEND_API_KEY'
  | 'EMAIL_FROM'
  | 'GOOGLE_CLIENT_ID'
  | 'GOOGLE_CLIENT_SECRET'
>;

function missing(env: EnvLike, names: Array<keyof EnvLike>): string[] {
  return names.filter((n) => {
    const v = env[n];
    return v === undefined || v === null || (typeof v === 'string' && v.trim() === '');
  }) as string[];
}

function envSentence(names: string[]): string {
  if (names.length === 1) return names[0] ?? '';
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

/**
 * Builds the status list from environment presence and stored connections. Pure, so it is unit tested;
 * messages tell the owner exactly what is needed and never imply that anything is connected when it is not.
 */
export function buildIntegrationStatuses(env: EnvLike, facts: ConnectionFacts): IntegrationStatus[] {
  const out: IntegrationStatus[] = [];
  const connection = (provider: string) => facts.connections.find((c) => c.provider === provider);
  const social = (platform: string) => facts.socialAccounts.find((s) => s.platform === platform && s.status === 'connected');

  // --- AI planning and vision
  const aiMissing = env.AI_PROVIDER === 'anthropic' ? missing(env, ['ANTHROPIC_API_KEY']) : ['AI_PROVIDER', ...missing(env, ['ANTHROPIC_API_KEY'])];
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
  });

  // --- Transcription (captions)
  const trMissing = env.TRANSCRIPTION_PROVIDER === 'openai' ? missing(env, ['OPENAI_API_KEY']) : ['TRANSCRIPTION_PROVIDER', ...missing(env, ['OPENAI_API_KEY'])];
  const trOn = env.TRANSCRIPTION_PROVIDER === 'openai' && trMissing.length === 0;
  out.push({
    id: 'transcription',
    name: 'Speech captions',
    areas: ['video'],
    configured: trOn,
    connected: trOn,
    missingEnv: trOn ? [] : trMissing,
    message: trOn
      ? 'Speech in your clips is transcribed so captions use the exact words spoken.'
      : 'Captions are switched off because no transcription service is set up. Set TRANSCRIPTION_PROVIDER=openai and OPENAI_API_KEY on the server to caption spoken words. Edits never show invented dialogue.',
    ...(trOn ? { detail: `Model: ${env.OPENAI_TRANSCRIPTION_MODEL}` } : {}),
  });

  // --- Storage
  const s3Missing = env.STORAGE_DRIVER === 's3' ? missing(env, ['S3_BUCKET', 'S3_ACCESS_KEY_ID', 'S3_SECRET_ACCESS_KEY']) : [];
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
  });

  // --- Instagram
  const igMissing = missing(env, ['META_APP_ID', 'META_APP_SECRET']);
  const ig = social('instagram');
  out.push({
    id: 'instagram',
    name: 'Instagram',
    areas: ['publishing'],
    configured: igMissing.length === 0,
    connected: Boolean(ig),
    missingEnv: igMissing,
    message: ig
      ? `Connected as @${ig.username}.`
      : igMissing.length
        ? `Needs setup: a Meta developer app is required. Add ${envSentence(igMissing)} to the server, then connect your Instagram professional account in Settings → Integrations.`
        : 'The Meta app is configured. Connect your Instagram professional account in Settings → Integrations to publish Reels. Until then, download the export and post it from your phone.',
    ...(ig ? { detail: `@${ig.username}` } : {}),
  });

  // --- TikTok
  const ttMissing = missing(env, ['TIKTOK_CLIENT_KEY', 'TIKTOK_CLIENT_SECRET']);
  const tt = social('tiktok');
  out.push({
    id: 'tiktok',
    name: 'TikTok',
    areas: ['publishing'],
    configured: ttMissing.length === 0,
    connected: Boolean(tt),
    missingEnv: ttMissing,
    message: tt
      ? `Connected as @${tt.username}. Videos are sent to your TikTok drafts for you to finish in the app.`
      : ttMissing.length
        ? `Needs setup: a TikTok developer app is required. Add ${envSentence(ttMissing)} to the server, then connect TikTok in Settings → Integrations. Until then, download the export and upload it in the TikTok app.`
        : 'The TikTok app is configured. Connect your TikTok account in Settings → Integrations to send videos to your drafts.',
    ...(tt ? { detail: `@${tt.username}` } : {}),
  });

  // --- Square
  const sqMissing = missing(env, ['SQUARE_APPLICATION_ID', 'SQUARE_APPLICATION_SECRET']);
  const sq = connection('square');
  const sqConnected = sq?.status === 'connected';
  out.push({
    id: 'square',
    name: 'Square Appointments',
    areas: ['appointments', 'reviews', 'email'],
    configured: sqMissing.length === 0,
    connected: sqConnected,
    missingEnv: [...sqMissing, ...missing(env, ['SQUARE_WEBHOOK_SIGNATURE_KEY'])],
    message: sqConnected
      ? `Connected${sq?.displayName ? ` to ${sq.displayName}` : ''}. Bookings sync from Square.`
      : sq?.status === 'needs_reauth'
        ? 'Square needs you to sign in again. Reconnect Square in Settings → Integrations.'
        : sqMissing.length
          ? `Needs setup: add ${envSentence(sqMissing)} from your Square developer dashboard to the server, then connect Square in Settings → Integrations. No bookings are shown until then.`
          : 'Square credentials are configured. Connect Square in Settings → Integrations to sync bookings.',
    ...(sq?.displayName ? { detail: sq.displayName } : {}),
  });

  // --- Email (Resend)
  const emMissing = missing(env, ['RESEND_API_KEY', 'EMAIL_FROM']);
  out.push({
    id: 'email',
    name: 'Email sending (Resend)',
    areas: ['email', 'reviews'],
    configured: emMissing.length === 0,
    connected: emMissing.length === 0,
    missingEnv: emMissing,
    message:
      emMissing.length === 0
        ? 'Email sending is set up. Every message still waits for your approval before it is sent.'
        : `Needs setup: create a Resend account, verify your sending domain, then add ${envSentence(emMissing)} to the server. Nothing is emailed until then.`,
    ...(emMissing.length === 0 && env.EMAIL_FROM ? { detail: `From: ${env.EMAIL_FROM}` } : {}),
  });

  // --- Google Business Profile
  const gMissing = missing(env, ['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET']);
  const gbp = connection('google_business_profile');
  out.push({
    id: 'google_business_profile',
    name: 'Google Business Profile',
    areas: ['reviews', 'website'],
    configured: gMissing.length === 0,
    connected: gbp?.status === 'connected',
    missingEnv: gMissing,
    message:
      gbp?.status === 'connected'
        ? `Connected${gbp.displayName ? ` to ${gbp.displayName}` : ''}.`
        : gMissing.length
          ? `Needs setup: add ${envSentence(gMissing)} from a Google Cloud project to the server, then connect your Business Profile in Settings → Integrations. Review requests can still use your review link from Settings → Business.`
          : 'Google credentials are configured. Connect your Business Profile in Settings → Integrations to see reviews here.',
    ...(gbp?.displayName ? { detail: gbp.displayName } : {}),
  });

  // --- Google Search Console
  const gsc = connection('google_search_console');
  out.push({
    id: 'google_search_console',
    name: 'Google Search Console',
    areas: ['website'],
    configured: gMissing.length === 0,
    connected: gsc?.status === 'connected',
    missingEnv: gMissing,
    message:
      gsc?.status === 'connected'
        ? 'Connected. Search performance for your website is available.'
        : gMissing.length
          ? `Needs setup: add ${envSentence(gMissing)} to the server, then connect Search Console in Settings → Integrations. You also need your website verified in Search Console.`
          : 'Google credentials are configured. Connect Search Console in Settings → Integrations (your website must be verified there).',
  });

  return out;
}

/** Live integration statuses for this server (used by /api/integrations/status and the section pages). */
export async function getIntegrationStatuses(): Promise<IntegrationStatus[]> {
  const env = getEnv();
  const db = getDb();
  const [connections, socialAccounts] = await Promise.all([
    db
      .select({ provider: schema.integrationConnections.provider, status: schema.integrationConnections.status, displayName: schema.integrationConnections.displayName })
      .from(schema.integrationConnections),
    db.select({ platform: schema.socialAccounts.platform, status: schema.socialAccounts.status, username: schema.socialAccounts.username }).from(schema.socialAccounts),
  ]);
  return buildIntegrationStatuses(env, { connections, socialAccounts });
}
