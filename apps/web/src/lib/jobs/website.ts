import type { RefIdResolver } from './types.js';

/**
 * The entity each website check and Search Console job is about, so progress lands on the right card (same rule as
 * the worker's module registration). Returns undefined for job types this module does not own.
 */
export const websiteRefId: RefIdResolver = (type, payload) => {
  const pick = (k: string) => (typeof payload[k] === 'string' ? (payload[k] as string) : null);
  switch (type) {
    case 'website.audit':
      return pick('auditId');
    case 'website.edit_apply':
    case 'website.copy_draft':
      return pick('editId');
    case 'website.connection_check':
      // The Performance probe belongs on the Business Profile card (it shares that connection).
      return payload['provider'] === 'business_profile_performance' ? 'google_business_profile' : pick('provider');
    case 'search.sync':
      return payload['source'] === 'business_profile' ? 'google_business_profile' : 'google_search_console';
    default:
      return undefined;
  }
};
