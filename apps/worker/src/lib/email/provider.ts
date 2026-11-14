import { testOnlyBaseUrl, type Env } from '@studio/config';
import type { WorkerContext } from '../../context.js';
import { POSTMARK_API_BASE, PostmarkProvider } from './postmark.js';

/**
 * The email provider interface (email design §3.1). Worker only: the web app never calls the provider. Postmark is
 * the only implementation; tests inject a fake. There is no simulated provider at runtime: when Postmark is not
 * configured, {@link createEmailProvider} returns null and nothing is sent.
 */

/** One email ready for the provider. Token links are already in the body; nothing here is logged. */
export interface OutboundEmail {
  emailMessageId: string;
  to: string;
  from: string;
  replyTo: string | null;
  subject: string;
  html: string;
  text: string;
  stream: 'transactional' | 'broadcast';
  tag: string;
  metadata: Record<string, string>;
}

/** What the provider said about one send. */
export type SendResult =
  | { ok: true; providerMessageId: string; submittedAt: string }
  | {
      ok: false;
      kind: 'transient' | 'unknown_outcome' | 'inactive_recipient' | 'invalid_recipient' | 'pending_approval' | 'sender_not_verified' | 'auth' | 'rejected';
      code: string;
      message: string;
    };

/** Outcome of the read-only provider check. */
export interface ProviderCheck {
  state: 'connected' | 'needs_attention' | 'needs_reauth' | 'error';
  deliveryType: 'live' | 'sandbox' | 'unknown';
  streams: { transactional: boolean; broadcast: boolean };
  /** Webhooks found on both streams; null = the list could not be read with a server token. */
  webhooks: { configured: boolean | null };
  serverName: string;
  message: string;
}

/** One webhook record, normalised. Webhooks may only restrict sending or update delivery display. */
export interface NormalisedEmailEvent {
  type: 'delivered' | 'bounced' | 'complained' | 'subscription_change' | 'ignored';
  providerMessageId: string | null;
  email: string | null;
  occurredAt: string;
  /** Bounce: a hard bounce (or Postmark marked the address inactive). */
  hard: boolean;
  /** SubscriptionChange: true = suppressed, false = reactivated, null = not a subscription change. */
  suppressSending: boolean | null;
  /** SubscriptionChange reason (`ManualSuppression`, `HardBounce`, `SpamComplaint`) or the bounce type. */
  suppressionReason: string | null;
  stream: string | null;
}

/** The provider contract every implementation (and the test fake) follows. */
export interface EmailProvider {
  readonly name: 'postmark';
  /** Read-only: server, streams and webhooks. Never sends. */
  check(signal: AbortSignal): Promise<ProviderCheck>;
  send(msg: OutboundEmail, signal: AbortSignal): Promise<SendResult>;
  /** Looks for an already-accepted message by our metadata (duplicate protection after an unknown outcome). */
  findSent(emailMessageId: string, to: string, signal: AbortSignal): Promise<string | null>;
  /** Adds an address to the stream's suppression list. Never removes one. */
  suppress(email: string, stream: 'transactional' | 'broadcast', signal: AbortSignal): Promise<void>;
  parseWebhook(body: unknown): NormalisedEmailEvent[];
}

/** The settings Postmark needs, or null when email sending is not set up on the server. */
export function postmarkSettings(env: Env): { token: string; from: string; transactionalStream: string; broadcastStream: string; apiBase: string } | null {
  if (env.EMAIL_PROVIDER !== 'postmark' || !env.POSTMARK_SERVER_TOKEN || !env.EMAIL_FROM) return null;
  return {
    token: env.POSTMARK_SERVER_TOKEN,
    from: env.EMAIL_FROM,
    transactionalStream: env.POSTMARK_TRANSACTIONAL_STREAM,
    broadcastStream: env.POSTMARK_BROADCAST_STREAM,
    // A local fake only under NODE_ENV=test (the Stage C browser test); every deployment calls Postmark itself.
    apiBase: testOnlyBaseUrl(env, env.POSTMARK_API_BASE_URL) ?? POSTMARK_API_BASE,
  };
}

/** The Postmark provider when `EMAIL_PROVIDER=postmark` and its token and sender are set, otherwise null. */
export function createEmailProvider(ctx: Pick<WorkerContext, 'env' | 'fetch' | 'logger'>): EmailProvider | null {
  const settings = postmarkSettings(ctx.env);
  return settings ? new PostmarkProvider(ctx, settings) : null;
}

/** What the email handlers depend on besides the context (tests pass a fake provider and a fixed clock). */
export interface EmailDeps {
  provider: EmailProvider | null;
  now: () => Date;
}

/** The real dependencies: Postmark when configured, and the system clock. */
export function defaultEmailDeps(ctx: Pick<WorkerContext, 'env' | 'fetch' | 'logger'>): EmailDeps {
  return { provider: createEmailProvider(ctx), now: () => new Date() };
}
