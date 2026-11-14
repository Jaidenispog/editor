import { randomUUID } from 'node:crypto';
import type { EmailProvider, NormalisedEmailEvent, OutboundEmail, ProviderCheck, SendResult } from '../../src/lib/email/provider.js';
import { parsePostmarkWebhook } from '../../src/lib/email/postmark.js';

/**
 * An in-memory email provider for tests: records every call and answers from scripted results. It never sends
 * anything anywhere. `sendResults` is consumed in order; when empty, sends succeed with a new message id.
 */
export class FakeEmailProvider implements EmailProvider {
  readonly name = 'postmark' as const;
  sends: OutboundEmail[] = [];
  finds: Array<{ emailMessageId: string; to: string }> = [];
  suppressed: Array<{ email: string; stream: string }> = [];
  checks = 0;
  sendResults: SendResult[] = [];
  /** Message ids `findSent` reports as already accepted (emailMessageId → provider id). */
  accepted = new Map<string, string>();
  checkResult: ProviderCheck = { state: 'connected', deliveryType: 'live', streams: { transactional: true, broadcast: true }, webhooks: { configured: true }, serverName: 'Fake server', message: '' };

  async check(): Promise<ProviderCheck> {
    this.checks++;
    return this.checkResult;
  }

  async send(msg: OutboundEmail): Promise<SendResult> {
    this.sends.push(msg);
    const scripted = this.sendResults.shift();
    if (scripted) {
      if (scripted.ok) this.accepted.set(msg.emailMessageId, scripted.providerMessageId);
      return scripted;
    }
    const id = `fake-pm-${randomUUID()}`;
    this.accepted.set(msg.emailMessageId, id);
    return { ok: true, providerMessageId: id, submittedAt: new Date().toISOString() };
  }

  async findSent(emailMessageId: string, to: string): Promise<string | null> {
    this.finds.push({ emailMessageId, to });
    return this.accepted.get(emailMessageId) ?? null;
  }

  async suppress(email: string, stream: 'transactional' | 'broadcast'): Promise<void> {
    this.suppressed.push({ email, stream });
  }

  parseWebhook(body: unknown): NormalisedEmailEvent[] {
    return parsePostmarkWebhook(body);
  }
}
