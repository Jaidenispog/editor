import { handleSearchSync } from '../../handlers/search-sync.js';
import { handleWebsiteAudit, trimOldAuditResults } from '../../handlers/website-audit.js';
import { handleWebsiteConnectionCheck } from '../../handlers/website-connection-check.js';
import { handleWebsiteCopyDraft } from '../../handlers/website-copy-draft.js';
import { handleWebsiteEditApply } from '../../handlers/website-edit-apply.js';
import { defineHandler, type WorkerModule } from '../types.js';

/**
 * Worker registrations of the website check and Search Console module (WP8): five handlers (one at a time each),
 * the daily Search Console sync, the cleanup of old check results, and the entity each job is about. There is no
 * audit cron: the owner starts every website check. Handlers are wrapped so this file can load first.
 */
export const websiteModule: WorkerModule = {
  name: 'website',
  handlers: [
    defineHandler('website.audit', (ctx, run, payload) => handleWebsiteAudit(ctx, run, payload)),
    defineHandler('website.edit_apply', (ctx, run, payload) => handleWebsiteEditApply(ctx, run, payload)),
    defineHandler('website.copy_draft', (ctx, run, payload) => handleWebsiteCopyDraft(ctx, run, payload)),
    defineHandler('website.connection_check', (ctx, run, payload) => handleWebsiteConnectionCheck(ctx, run, payload)),
    defineHandler('search.sync', (ctx, run, payload) => handleSearchSync(ctx, run, payload)),
  ],
  // Daily at 7:37 am Melbourne time; skipped with a message while Search Console isn't connected.
  crons: [
    {
      type: 'search.sync',
      cron: '37 7 * * *',
      payload: { source: 'search_console', reason: 'daily' },
      key: 'search_console_daily',
    },
  ],
  cleanupTasks: [{ name: 'website', run: (ctx) => trimOldAuditResults(ctx) }],
  refIdFor: (type, payload) => {
    switch (type) {
      case 'website.audit':
        return typeof payload['auditId'] === 'string' ? payload['auditId'] : null;
      case 'website.edit_apply':
      case 'website.copy_draft':
        return typeof payload['editId'] === 'string' ? payload['editId'] : null;
      case 'website.connection_check':
        // The Performance probe belongs on the Business Profile card (it shares that connection).
        if (payload['provider'] === 'business_profile_performance') return 'google_business_profile';
        return typeof payload['provider'] === 'string' ? payload['provider'] : null;
      case 'search.sync':
        return payload['source'] === 'business_profile' ? 'google_business_profile' : 'google_search_console';
      default:
        return undefined;
    }
  },
};
