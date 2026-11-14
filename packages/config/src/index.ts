import { z } from 'zod';

const bool = z
  .enum(['true', 'false', '1', '0', ''])
  .optional()
  .transform((v) => v === 'true' || v === '1');

/** An optional whole number within [min, max]; an empty string counts as unset. */
function optionalInt(min: number, max: number) {
  return z.preprocess((v) => (typeof v === 'string' && v.trim() === '' ? undefined : v), z.coerce.number().int().min(min).max(max).optional());
}

/**
 * Every runtime setting the app and worker read from the environment, validated once at start-up.
 * Secrets stay server-side: nothing here is ever sent to the browser.
 */
export const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
  APP_URL: z.string().url().default('http://localhost:3000'),

  DATABASE_URL: z.string().min(1),
  /** Optional separate connection for the queue (e.g. Supabase session-mode pooler). Defaults to DATABASE_URL. */
  QUEUE_DATABASE_URL: z.string().min(1).optional(),
  /**
   * Largest database pool this process opens for app queries. Unset keeps the defaults (web 10, worker 8).
   * Lower it on small hosted databases such as Supabase Micro; see docs/deployment.md.
   */
  DB_POOL_MAX: optionalInt(1, 100),
  /** Largest pool the job queue (pg-boss) opens. Unset keeps the defaults (web 3, worker 6). */
  QUEUE_POOL_MAX: optionalInt(1, 100),

  /** 32+ random bytes, base64 or hex. Signs session cookies and media links. */
  APP_SECRET: z.string().min(32),
  /** 32-byte key (base64) for encrypting OAuth tokens at rest. Defaults to a key derived from APP_SECRET. */
  APP_ENCRYPTION_KEY: z.string().optional(),

  STORAGE_DRIVER: z.enum(['local', 's3']).default('local'),
  STORAGE_LOCAL_ROOT: z.string().default('./data/storage'),
  S3_ENDPOINT: z.string().optional(),
  S3_REGION: z.string().default('auto'),
  S3_BUCKET: z.string().optional(),
  S3_ACCESS_KEY_ID: z.string().optional(),
  S3_SECRET_ACCESS_KEY: z.string().optional(),
  S3_FORCE_PATH_STYLE: bool,
  /** Seconds a signed media link stays valid. */
  MEDIA_LINK_TTL_SECONDS: z.coerce.number().int().min(60).max(86400).default(3600),
  MAX_UPLOAD_BYTES: z.coerce.number().int().positive().default(6 * 1024 * 1024 * 1024),

  WORKER_TMP_DIR: z.string().default('./tmp/worker'),
  WORKER_CONCURRENCY: z.coerce.number().int().min(1).max(8).default(1),
  FFMPEG_PATH: z.string().default('ffmpeg'),
  FFPROBE_PATH: z.string().default('ffprobe'),
  /** CPU threads FFmpeg may use per render (0 = auto). */
  FFMPEG_THREADS: z.coerce.number().int().min(0).max(64).default(0),

  AI_PROVIDER: z.enum(['anthropic', 'none']).default('none'),
  ANTHROPIC_API_KEY: z.string().optional(),
  AI_PLANNER_MODEL: z.string().default('claude-opus-5-5'),
  AI_PLANNER_EFFORT: z.enum(['low', 'medium', 'high']).default('medium'),
  AI_VISION_MODEL: z.string().default('claude-haiku-5-5'),
  /** Upper bound on sampled frames sent to the vision model per clip. */
  AI_VISION_MAX_FRAMES_PER_CLIP: z.coerce.number().int().min(2).max(40).default(10),
  /**
   * Speech-to-text for captions. `deepgram` (Nova-3, word and utterance timestamps) is the recommended provider.
   * `openai` uses whisper-1, which OpenAI has announced will shut down on 26 February 2027; newer OpenAI models
   * return no timestamps, so they cannot time captions.
   */
  TRANSCRIPTION_PROVIDER: z.enum(['none', 'deepgram', 'openai']).default('none'),
  DEEPGRAM_API_KEY: z.string().optional(),
  DEEPGRAM_MODEL: z.string().min(1).default('nova-3'),
  OPENAI_API_KEY: z.string().optional(),
  OPENAI_TRANSCRIPTION_MODEL: z.string().default('whisper-1'),

  // Stage B/C integrations (all optional; features show setup guidance when missing)
  // --- Publishing (Instagram through a Meta app; TikTok is posted by hand unless Zernio is switched on)
  META_APP_ID: z.string().optional(),
  META_APP_SECRET: z.string().optional(),
  /** Facebook Login for Business configuration id (the login dialog sends it instead of a scope list). */
  META_LOGIN_CONFIG_ID: z.string().optional(),
  /** Graph API version used for every Meta call; the connection check records the version that worked. */
  META_GRAPH_VERSION: z.string().regex(/^v\d+\.\d+$/, 'Expected a version like v26.0').default('v26.0'),
  /** Not used: TikTok has no direct posting here. Kept so older .env files still load. */
  TIKTOK_CLIENT_KEY: z.string().optional(),
  TIKTOK_CLIENT_SECRET: z.string().optional(),
  /** `zernio` turns on the optional automatic TikTok posting through Zernio (Stage C); `none` keeps manual posting only. */
  TIKTOK_PUBLISH_PROVIDER: z.enum(['none', 'zernio']).default('none'),
  ZERNIO_API_BASE_URL: optionalUrl(),
  ZERNIO_WEBHOOK_SECRET: z.string().optional(),
  // --- Trends
  YOUTUBE_API_KEY: z.string().optional(),
  // --- Square appointments
  SQUARE_APPLICATION_ID: z.string().optional(),
  SQUARE_APPLICATION_SECRET: z.string().optional(),
  SQUARE_ENVIRONMENT: z.enum(['sandbox', 'production']).default('sandbox'),
  SQUARE_WEBHOOK_SIGNATURE_KEY: z.string().optional(),
  /** The exact webhook address registered in Square, when it differs from APP_URL + /api/webhooks/square. */
  SQUARE_WEBHOOK_NOTIFICATION_URL: optionalUrl(),
  // --- Email and reviews
  /** `postmark` sends email through Postmark; `none` keeps every email as a draft. */
  EMAIL_PROVIDER: z.enum(['none', 'postmark']).default('none'),
  POSTMARK_SERVER_TOKEN: z.string().optional(),
  POSTMARK_TRANSACTIONAL_STREAM: z.string().min(1).default('outbound'),
  POSTMARK_BROADCAST_STREAM: z.string().min(1).default('broadcast'),
  POSTMARK_WEBHOOK_USERNAME: z.string().optional(),
  POSTMARK_WEBHOOK_PASSWORD: z.string().optional(),
  /** Not used: Postmark replaced Resend. Kept so older .env files still load. */
  RESEND_API_KEY: z.string().optional(),
  EMAIL_FROM: z.string().optional(),
  /** Google Places key used only to show the studio's own rating and review count. */
  GOOGLE_MAPS_API_KEY: z.string().optional(),
  // --- Google sign-in (Business Profile and Search Console)
  GOOGLE_CLIENT_ID: z.string().optional(),
  GOOGLE_CLIENT_SECRET: z.string().optional(),
  // --- Website
  /** Model used only when the owner asks for AI wording of a website change. */
  AI_WEBSITE_MODEL: z.string().min(1).default('claude-haiku-5-5'),

  // Test only: local fake servers. Honoured only when NODE_ENV=test.
  META_GRAPH_BASE_URL: optionalUrl(),
  META_RUPLOAD_BASE_URL: optionalUrl(),
  SQUARE_API_BASE_URL: optionalUrl(),
});

/** An optional absolute http(s) URL; an empty string counts as unset. */
function optionalUrl() {
  return z.preprocess((v) => (typeof v === 'string' && v.trim() === '' ? undefined : v), z.string().url().optional());
}

export type Env = z.infer<typeof EnvSchema>;

let cached: Env | null = null;

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  if (cached && source === process.env) return cached;
  const parsed = EnvSchema.safeParse(source);
  if (!parsed.success) {
    const lines = parsed.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`).join('\n');
    throw new Error(`Invalid environment configuration:\n${lines}`);
  }
  const env = parsed.data;
  if (env.STORAGE_DRIVER === 's3' && (!env.S3_BUCKET || !env.S3_ACCESS_KEY_ID || !env.S3_SECRET_ACCESS_KEY)) {
    throw new Error('STORAGE_DRIVER=s3 requires S3_BUCKET, S3_ACCESS_KEY_ID and S3_SECRET_ACCESS_KEY');
  }
  if (env.AI_PROVIDER === 'anthropic' && !env.ANTHROPIC_API_KEY) {
    throw new Error('AI_PROVIDER=anthropic requires ANTHROPIC_API_KEY');
  }
  if (env.TRANSCRIPTION_PROVIDER === 'deepgram' && !env.DEEPGRAM_API_KEY) {
    throw new Error('TRANSCRIPTION_PROVIDER=deepgram requires DEEPGRAM_API_KEY');
  }
  if (env.EMAIL_PROVIDER === 'postmark' && (!env.POSTMARK_SERVER_TOKEN || !env.EMAIL_FROM)) {
    throw new Error('EMAIL_PROVIDER=postmark requires POSTMARK_SERVER_TOKEN and EMAIL_FROM');
  }
  if (source === process.env) cached = env;
  return env;
}

/** Non-secret summary of which optional capabilities are configured, safe to show in Settings. */
export function describeCapabilities(env: Env) {
  return {
    ai: {
      planner: env.AI_PROVIDER === 'anthropic' ? { provider: 'anthropic', model: env.AI_PLANNER_MODEL, effort: env.AI_PLANNER_EFFORT } : null,
      vision: env.AI_PROVIDER === 'anthropic' ? { provider: 'anthropic', model: env.AI_VISION_MODEL } : null,
      transcription:
        env.TRANSCRIPTION_PROVIDER === 'deepgram' && env.DEEPGRAM_API_KEY
          ? { provider: 'deepgram', model: env.DEEPGRAM_MODEL }
          : env.TRANSCRIPTION_PROVIDER === 'openai' && env.OPENAI_API_KEY
            ? { provider: 'openai', model: env.OPENAI_TRANSCRIPTION_MODEL }
            : null,
    },
    storage: { driver: env.STORAGE_DRIVER },
    integrations: {
      instagram: Boolean(env.META_APP_ID && env.META_APP_SECRET && env.META_LOGIN_CONFIG_ID),
      /** TikTok automatic posting (Zernio, Stage C). Manual posting is always available. */
      tiktok: env.TIKTOK_PUBLISH_PROVIDER === 'zernio' && Boolean(env.ZERNIO_API_BASE_URL),
      square: Boolean(env.SQUARE_APPLICATION_ID && env.SQUARE_APPLICATION_SECRET),
      email: env.EMAIL_PROVIDER === 'postmark' && Boolean(env.POSTMARK_SERVER_TOKEN && env.EMAIL_FROM),
      google: Boolean(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET),
    },
    /** Per module: which optional server settings are present (never their values). */
    modules: {
      publishing: {
        instagramDirect: Boolean(env.META_APP_ID && env.META_APP_SECRET && env.META_LOGIN_CONFIG_ID),
        graphVersion: env.META_GRAPH_VERSION,
        tiktokProvider: env.TIKTOK_PUBLISH_PROVIDER,
        zernioWebhookSigning: Boolean(env.ZERNIO_WEBHOOK_SECRET),
      },
      trends: { youtubeChart: Boolean(env.YOUTUBE_API_KEY) },
      square: {
        oauth: Boolean(env.SQUARE_APPLICATION_ID && env.SQUARE_APPLICATION_SECRET),
        environment: env.SQUARE_ENVIRONMENT,
        webhooks: Boolean(env.SQUARE_WEBHOOK_SIGNATURE_KEY),
      },
      email: {
        provider: env.EMAIL_PROVIDER,
        sending: env.EMAIL_PROVIDER === 'postmark' && Boolean(env.POSTMARK_SERVER_TOKEN && env.EMAIL_FROM),
        webhooks: Boolean(env.POSTMARK_WEBHOOK_USERNAME && env.POSTMARK_WEBHOOK_PASSWORD),
        placesRating: Boolean(env.GOOGLE_MAPS_API_KEY),
      },
      google: { oauth: Boolean(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET) },
      website: { aiWordingModel: env.AI_PROVIDER === 'anthropic' ? env.AI_WEBSITE_MODEL : null },
    },
  };
}
export type CapabilitySummary = ReturnType<typeof describeCapabilities>;

/**
 * A test-only base URL (local fake server) for an external API. Returned only when NODE_ENV=test, so a stray
 * setting can never point a real deployment at another host.
 */
export function testOnlyBaseUrl(env: Pick<Env, 'NODE_ENV'>, value: string | undefined): string | null {
  return env.NODE_ENV === 'test' && value ? value.replace(/\/+$/, '') : null;
}
