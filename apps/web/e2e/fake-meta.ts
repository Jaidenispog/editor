/**
 * Runs WP4's local fake of Meta (apps/worker/test/fakes/graph-server.ts) as its own process for the Stage B browser
 * test: the Graph API, the rupload host and the Unified Login dialog, all on one local port. The web app and the
 * worker reach it through META_GRAPH_BASE_URL, META_RUPLOAD_BASE_URL and META_DIALOG_BASE_URL, which the app honours
 * only under NODE_ENV=test. Nothing here talks to Meta.
 *
 *   FAKE_META_PORT=4590 tsx apps/web/e2e/fake-meta.ts
 *
 * Prints one JSON line `{"msg":"fake meta listening","url":…}` once it accepts connections; `GET /__fake/state`
 * returns what it published and how often each endpoint was called. Stops on SIGTERM or SIGINT.
 */
import { startFakeGraphServer } from '../../worker/test/fakes/graph-server.js';

const port = Number(process.env['FAKE_META_PORT'] ?? '0');
if (!Number.isInteger(port) || port < 0 || port > 65_535) {
  console.error('FAKE_META_PORT must be a port number.');
  process.exit(2);
}

const fake = await startFakeGraphServer({}, { port, host: '127.0.0.1' });
console.log(JSON.stringify({ msg: 'fake meta listening', url: fake.url, igUserId: fake.scenario.igUserId, username: fake.scenario.username }));

let stopping = false;
const stop = (): void => {
  if (stopping) return;
  stopping = true;
  void fake.close().then(() => process.exit(0));
};
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
