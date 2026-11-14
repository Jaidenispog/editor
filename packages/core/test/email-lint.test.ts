import { describe, expect, it } from 'vitest';
import { DEFAULT_EMAIL_TEMPLATES } from '../src/email.js';
import { lintEmail } from '../src/email-lint.js';

const codes = (r: ReturnType<typeof lintEmail>) => r.errors.map((e) => e.code);
const review = (body: string) => lintEmail({ messageClass: 'review_request', subject: 'A quick favour', bodyMarkdown: `${body} [Review]({{review_link}})` });

describe('lintEmail', () => {
  it('passes every built-in template', () => {
    for (const t of DEFAULT_EMAIL_TEMPLATES) expect(lintEmail(t).errors, t.name).toEqual([]);
  });

  it('checks the basics for every class', () => {
    expect(codes(lintEmail({ messageClass: 'campaign', subject: '', bodyMarkdown: '' }))).toEqual(expect.arrayContaining(['subject_empty', 'body_empty']));
    expect(codes(lintEmail({ messageClass: 'campaign', subject: 'x'.repeat(121), bodyMarkdown: 'Hi' }))).toContain('subject_long');
    expect(codes(lintEmail({ messageClass: 'campaign', subject: 'Hi', bodyMarkdown: 'Hi {{nickname}}' }))).toContain('unknown_variable');
    expect(codes(lintEmail({ messageClass: 'campaign', subject: 'Hi', bodyMarkdown: '[x](http://insecure.example)' }))).toContain('bad_link');
    expect(codes(lintEmail({ messageClass: 'campaign', subject: 'Hi', bodyMarkdown: '<b>bold</b>' }))).toContain('raw_html');
    const w = lintEmail({ messageClass: 'campaign', subject: 'BIG NEWS TODAY', bodyMarkdown: '[a](https://a.example) [b](https://b.example) [c](https://c.example) [d](https://d.example)' });
    expect(w.warnings.map((x) => x.code)).toEqual(expect.arrayContaining(['subject_caps', 'many_links', 'campaign_no_name']));
  });

  it('blocks links, promotion and reminder wording in factual emails', () => {
    const f = (body: string) => codes(lintEmail({ messageClass: 'transactional_factual', subject: 'About your cut', bodyMarkdown: body }));
    expect(f('Visit [our site](https://studio.example)')).toContain('factual_link');
    expect(f('Book again: {{booking_link}}')).toContain('factual_link');
    expect(f('Enjoy 20% off next time')).toContain('factual_promotional');
    expect(f('Grab a free beard trim')).toContain('factual_promotional');
    expect(f('This is a reminder about tomorrow')).toContain('factual_reminder');
    expect(f('Your appointment is on Friday')).toContain('factual_reminder');
    expect(f('See you tomorrow!')).toContain('factual_reminder');
    expect(f('Thanks for coming in. Keep the product light.')).toEqual([]);
    const reminder = lintEmail({ messageClass: 'transactional_factual', subject: 'x', bodyMarkdown: 'reminder' }).errors.find((e) => e.code === 'factual_reminder');
    expect(reminder?.message).toMatch(/Square already sends booking confirmations and reminders/);
  });

  it('review requests need the link and block incentives, gating and staff targets (whole words only)', () => {
    expect(codes(lintEmail({ messageClass: 'review_request', subject: 'Hi', bodyMarkdown: 'Please review us' }))).toContain('review_link_missing');
    expect(codes(review('Leave a review for a free trim'))).toContain('review_incentive');
    expect(codes(review('Leave a review and go in the draw'))).toContain('review_incentive');
    expect(codes(review('We value your freedom to say anything'))).toEqual([]);
    expect(codes(review('Visit our window display'))).toEqual([]);
    expect(codes(review('If you were happy, leave us 5 stars'))).toContain('review_selective');
    expect(codes(review('If you enjoyed it, tell Google'))).toContain('review_selective');
    expect(codes(review('Not happy? Contact us first'))).toContain('review_selective');
    expect(codes(review('Help Alex reach the monthly goal'))).toContain('review_target');
    expect(review('Book again {{booking_link}}').warnings.map((w) => w.code)).toContain('review_booking_link');
    const incentive = review('free').errors.find((e) => e.code === 'review_incentive');
    expect(incentive?.message).toMatch(/Google and the ACCC/);
  });
});
