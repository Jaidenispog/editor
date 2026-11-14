import { describe, expect, it } from 'vitest';
import { missingIdentityFields, renderEmail, type RenderEmailInput } from '../src/email.js';

const base: RenderEmailInput = {
  messageClass: 'transactional_factual',
  subject: 'Looking after your cut',
  bodyMarkdown: 'Hi {{first_name}},\n\nThanks for coming in on {{visit_date}}.',
  vars: { firstName: 'Sam', businessName: 'Ivanhoe Studio', visitDate: new Date('2026-11-14T02:00:00Z'), serviceName: 'Skin fade', senderName: 'Alex', bookingLink: 'https://book.example/studio' },
  identity: { businessName: 'Ivanhoe Studio', addressLine: '1 Upper Heidelberg Rd', suburb: 'Ivanhoe', state: 'VIC', postcode: '3079', phone: '03 9000 0000', email: 'hello@studio.example' },
  reviewLinkUrl: null,
  unsubscribeUrl: null,
  accentColour: '#C8A24A',
};

describe('renderEmail', () => {
  it('escapes everything that is data, including client names', () => {
    const r = renderEmail({ ...base, vars: { ...base.vars, firstName: '<script>alert(1)</script>' } });
    expect(r.html).not.toContain('<script>');
    expect(r.html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(r.text).toContain('Hi <script>alert(1)</script>,');
  });

  it('renders the Markdown subset and escapes raw HTML in the source', () => {
    const r = renderEmail({ ...base, messageClass: 'campaign', bodyMarkdown: '**Bold** and *italic*\nsecond line\n\n- one\n- two\n\n<b>raw</b> [Book]({{booking_link}}) [x](javascript:alert(1))' });
    expect(r.html).toContain('<strong>Bold</strong> and <em>italic</em><br>second line');
    expect(r.html).toContain('<ul');
    expect(r.html).toContain('<li style="margin:0 0 6px">one</li>');
    expect(r.html).toContain('&lt;b&gt;raw&lt;/b&gt;');
    expect(r.html).toContain('href="https://book.example/studio"');
    expect(r.html).not.toContain('javascript:');
    expect(r.text).toContain('Book (https://book.example/studio)');
  });

  it('fills variables with Melbourne dates and fallbacks', () => {
    const r = renderEmail(base);
    expect(r.text).toContain('Thanks for coming in on Saturday 14 November.');
    const anon = renderEmail({ ...base, vars: { ...base.vars, firstName: null } });
    expect(anon.text).toContain('Hi there,');
  });

  it('always adds the sender identification, and the unsubscribe text only to commercial classes', () => {
    const factual = renderEmail(base);
    expect(factual.text).toContain('Ivanhoe Studio\n1 Upper Heidelberg Rd, Ivanhoe VIC 3079\n03 9000 0000 · hello@studio.example');
    expect(factual.html).not.toContain('Unsubscribe');
    const commercial = renderEmail({ ...base, messageClass: 'campaign', unsubscribeUrl: 'https://app.example/u/TOKEN123' });
    expect(commercial.html).toContain('{{{ pm:unsubscribe }}}');
    expect(commercial.html).toContain('https://app.example/u/TOKEN123');
    expect(commercial.text).toContain('call 03 9000 0000');
  });

  it('stores copies with markers instead of personal token links', () => {
    const r = renderEmail({ ...base, messageClass: 'review_request', bodyMarkdown: 'Hi {{first_name}}. [Leave a Google review]({{review_link}})', reviewLinkUrl: 'https://app.example/r/REVIEWTOKEN', unsubscribeUrl: 'https://app.example/u/UNSUBTOKEN' });
    expect(r.html).toContain('https://app.example/r/REVIEWTOKEN');
    expect(r.storedHtml).not.toContain('REVIEWTOKEN');
    expect(r.storedHtml).not.toContain('UNSUBTOKEN');
    expect(r.storedText).not.toContain('UNSUBTOKEN');
    expect(r.storedHtml).toContain('[review link]');
    expect(r.storedText).toContain('[unsubscribe link]');
  });

  it('renders {{booking_link}} as a link only when the saved booking link is https', () => {
    for (const bad of ['http://book.example/studio', 'javascript:alert(1)', 'book.example/studio', 'data:text/html,hi']) {
      const r = renderEmail({ ...base, messageClass: 'campaign', bodyMarkdown: '[Book again]({{booking_link}})', vars: { ...base.vars, bookingLink: bad } });
      expect(r.html).not.toContain('href="' + bad);
      expect(r.html).not.toMatch(/<a href="(?!\{\{\{ pm:unsubscribe)/);
      expect(r.html).toContain('Book again');
      expect(r.text).toContain('Book again');
      expect(r.text).not.toContain(`(${bad})`);
    }
    const ok = renderEmail({ ...base, messageClass: 'campaign', bodyMarkdown: '[Book again]({{booking_link}})' });
    expect(ok.html).toContain('href="https://book.example/studio"');
  });
});

describe('missingIdentityFields', () => {
  it('needs the full street address, including the state', () => {
    expect(missingIdentityFields(base.identity)).toEqual([]);
    expect(missingIdentityFields({ ...base.identity, state: ' ' })).toEqual(['street address']);
    expect(missingIdentityFields({ ...base.identity, suburb: '' })).toEqual(['street address']);
  });
});
