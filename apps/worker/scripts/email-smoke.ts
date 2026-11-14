/**
 * Postmark sandbox smoke test (email design §11.3). Run by hand, with the owner present, against a Postmark server
 * whose delivery type is **Sandbox**: nothing reaches a client, and the only address ever used is the one given on
 * the command line (the owner's own). It never touches the database.
 *
 *   pnpm --filter @studio/worker exec tsx scripts/email-smoke.ts                       # read-only check only
 *   pnpm --filter @studio/worker exec tsx scripts/email-smoke.ts --send-to-self you@your-domain.com.au
 *
 * With `--send-to-self` it sends one Transactional and one Broadcast message to that address, then looks both up by
 * metadata (`findSent`). It refuses to send unless the check reports `DeliveryType: Sandbox`. Record the results
 * (date, response shapes with addresses removed) in `docs/research/email-smoke-YYYY-MM-DD.md`.
 */
import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import pino from 'pino';
import { loadEnv } from '@studio/config';
import { renderEmail } from '@studio/core';
import { PostmarkProvider } from '../src/lib/email/postmark.js';
import { postmarkSettings } from '../src/lib/email/provider.js';
import { redact } from '../src/lib/http.js';

async function main(): Promise<void> {
  const env = loadEnv(process.env);
  const settings = postmarkSettings(env);
  if (!settings) {
    console.error('Email sending is not set up: EMAIL_PROVIDER=postmark, POSTMARK_SERVER_TOKEN and EMAIL_FROM are needed.');
    process.exitCode = 1;
    return;
  }
  const logger = pino({ level: 'info' });
  const provider = new PostmarkProvider({ logger }, settings);
  const signal = AbortSignal.timeout(60_000);
  const check = await provider.check(signal);
  console.log('Check (read-only):', JSON.stringify(redact(check), null, 2));

  const idx = process.argv.indexOf('--send-to-self');
  const to = idx > 0 ? process.argv[idx + 1] : undefined;
  if (!to) {
    console.log('No --send-to-self address given: nothing was sent.');
    return;
  }
  if (check.deliveryType !== 'sandbox') {
    console.error('Refusing to send: this Postmark server is not a Sandbox server. Use a Sandbox server for the smoke test.');
    process.exitCode = 1;
    return;
  }
  const identity = { businessName: 'Smoke test', addressLine: 'Owner smoke test', suburb: 'Ivanhoe', state: 'VIC', postcode: '3079', phone: '', email: to };
  for (const stream of ['transactional', 'broadcast'] as const) {
    const id = `smoke-${randomUUID()}`;
    const r = renderEmail({
      messageClass: stream === 'broadcast' ? 'campaign' : 'transactional_factual',
      subject: `[Smoke test] ${stream}`,
      bodyMarkdown: 'This is the Studio Assistant sandbox smoke test. It was sent to your own address only.',
      vars: { firstName: null, businessName: 'Smoke test', visitDate: null, serviceName: null, senderName: 'Studio Assistant', bookingLink: null },
      identity,
      reviewLinkUrl: null,
      unsubscribeUrl: stream === 'broadcast' ? `${env.APP_URL.replace(/\/+$/, '')}/u/smoke-test-token-not-stored` : null,
      accentColour: '#111111',
    });
    const res = await provider.send({ emailMessageId: id, to, from: settings.from, replyTo: null, subject: r.subject, html: r.html, text: r.text, stream, tag: 'smoke_test', metadata: { emailMessageId: id } }, signal);
    console.log(`Send (${stream}):`, JSON.stringify(redact(res)));
    const found = await provider.findSent(id, to, signal);
    console.log(`findSent (${stream}):`, found ? 'found' : 'not found');
  }
}

main().catch((err) => {
  console.error('Smoke test failed:', err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
