/**
 * Environment and connection combinations used to pin the wording of the integration cards that existed before the
 * Stage B/C registry (test/fixtures/integration-statuses-stage-a.json was produced from the Stage A code with these).
 */
const base = {
  NODE_ENV: 'test' as const,
  AI_PROVIDER: 'none' as const,
  AI_PLANNER_MODEL: 'claude-opus-5-5',
  AI_VISION_MODEL: 'claude-haiku-5-5',
  AI_WEBSITE_MODEL: 'claude-haiku-5-5',
  TRANSCRIPTION_PROVIDER: 'none' as const,
  DEEPGRAM_MODEL: 'nova-3',
  OPENAI_TRANSCRIPTION_MODEL: 'whisper-1',
  STORAGE_DRIVER: 'local' as const,
  META_GRAPH_VERSION: 'v26.0',
  TIKTOK_PUBLISH_PROVIDER: 'none' as const,
  SQUARE_ENVIRONMENT: 'sandbox' as const,
  EMAIL_PROVIDER: 'none' as const,
  POSTMARK_TRANSACTIONAL_STREAM: 'outbound',
  POSTMARK_BROADCAST_STREAM: 'broadcast',
};

const configured = {
  ...base,
  AI_PROVIDER: 'anthropic' as const,
  ANTHROPIC_API_KEY: 'k',
  TRANSCRIPTION_PROVIDER: 'deepgram' as const,
  DEEPGRAM_API_KEY: 'k',
  STORAGE_DRIVER: 's3' as const,
  S3_BUCKET: 'b',
  S3_ACCESS_KEY_ID: 'a',
  S3_SECRET_ACCESS_KEY: 's',
  S3_ENDPOINT: 'https://proj.storage.supabase.co/storage/v1/s3',
  META_APP_ID: 'm',
  META_APP_SECRET: 'm',
  TIKTOK_CLIENT_KEY: 't',
  TIKTOK_CLIENT_SECRET: 't',
  SQUARE_APPLICATION_ID: 's',
  SQUARE_APPLICATION_SECRET: 's',
  SQUARE_WEBHOOK_SIGNATURE_KEY: 'w',
  RESEND_API_KEY: 'r',
  EMAIL_FROM: 'Studio <hello@example.com.au>',
  GOOGLE_CLIENT_ID: 'g',
  GOOGLE_CLIENT_SECRET: 'g',
};

const noFacts = { connections: [], socialAccounts: [] };

export const WORDING_CASES = [
  { name: 'nothing set up', env: base, facts: noFacts },
  { name: 'openai transcription, s3 missing keys', env: { ...base, TRANSCRIPTION_PROVIDER: 'openai' as const, STORAGE_DRIVER: 's3' as const, S3_BUCKET: 'b' }, facts: noFacts },
  { name: 'deepgram selected without key', env: { ...base, TRANSCRIPTION_PROVIDER: 'deepgram' as const }, facts: noFacts },
  { name: 'everything configured, nothing connected', env: configured, facts: noFacts },
  {
    name: 'everything connected',
    env: configured,
    facts: {
      connections: [
        { provider: 'square', status: 'connected', displayName: 'Ivanhoe Studio' },
        { provider: 'google_business_profile', status: 'connected', displayName: 'Ivanhoe Studio (GBP)' },
        { provider: 'google_search_console', status: 'connected', displayName: '' },
      ],
      socialAccounts: [
        { platform: 'instagram', status: 'connected', username: 'ivanhoecuts' },
        { platform: 'tiktok', status: 'connected', username: 'ivanhoecuts' },
      ],
    },
  },
  {
    name: 'square needs reauth',
    env: configured,
    facts: { connections: [{ provider: 'square', status: 'needs_reauth', displayName: '' }], socialAccounts: [{ platform: 'instagram', status: 'needs_reauth', username: 'x' }] },
  },
];
