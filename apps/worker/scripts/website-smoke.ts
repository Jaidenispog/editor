/**
 * Website check smoke test against a REAL site (design §12.3 step 1). Run it by hand, only on a site you own or have
 * the owner's permission to check:
 *
 *   pnpm --filter @studio/worker exec tsx scripts/website-smoke.ts --audit https://example.com.au/ --i-own-this-site
 *
 * It reads up to 25 pages with the production crawler (robots.txt respected, SSRF guard on, polite spacing, request
 * caps), prints the request log and a findings summary, and writes nothing anywhere: no database, no changes to the
 * site. It never applies changes and never calls Google or WordPress.
 */
import { AUDIT_PRODUCT_TOKEN, AppSettingsSchema, prioritiseFindings, runWebsiteChecks, settingsSnapshot, siteScopeFrom } from '@studio/core';
import { crawlSite } from '../src/website/crawl.js';
import { DEFAULT_FETCH_POLICY, WebsiteFetcher } from '../src/website/fetcher.js';

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const url = args[args.indexOf('--audit') + 1];
  if (!args.includes('--audit') || !url) {
    console.error('Usage: tsx scripts/website-smoke.ts --audit <https://your-site/> --i-own-this-site');
    process.exit(2);
  }
  if (!args.includes('--i-own-this-site')) {
    console.error('Refusing to run: add --i-own-this-site to confirm the site is yours (or its owner agreed).');
    process.exit(2);
  }
  const scope = siteScopeFrom(url);
  if (!scope) {
    console.error(`Not a plain public http(s) address: ${url}`);
    process.exit(2);
  }
  const settings = AppSettingsSchema.parse({ business: { website: url } });
  const fetcher = new WebsiteFetcher(DEFAULT_FETCH_POLICY, [scope.host, scope.twinHost]);
  const controller = new AbortController();
  process.on('SIGINT', () => controller.abort());
  const started = Date.now();
  const out = await crawlSite({
    scope,
    snapshot: settingsSnapshot(settings),
    checkExternalLinks: true,
    watchTexts: new Map(),
    fetcher,
    signal: controller.signal,
    progress: async (_f, message) => {
      process.stderr.write(`${message}\n`);
    },
    checkCancelled: () => {
      if (controller.signal.aborted) throw new Error('Stopped');
    },
  });
  console.log(`\nRequest log (${fetcher.requestCount} requests as ${AUDIT_PRODUCT_TOKEN}, ${Math.round((Date.now() - started) / 1000)} s):`);
  let previous: number | null = null;
  for (const r of fetcher.log) {
    console.log(`${r.method.padEnd(4)} ${String(r.status ?? '---').padEnd(4)} +${previous === null ? 0 : r.at - previous} ms  ${r.url}`);
    previous = r.at;
  }
  const findings = out.blockedByRobots ? [] : prioritiseFindings(runWebsiteChecks(out.facts, settings));
  console.log(`\nPages: ${out.facts.pages.length}; partial: ${out.partialReasons.join(' ') || 'no'}`);
  for (const f of findings) console.log(`[${f.severity}] ${f.checkId}: ${f.detail}`);
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
