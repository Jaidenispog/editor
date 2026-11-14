/**
 * Stage C browser test helper: adds one staff (barber) account, which the app has no screen for yet. The password is
 * hashed with the app's own Argon2id settings (`src/lib/auth-core.ts`), so the account signs in like any other.
 *
 *   DATABASE_URL=… STAFF_PASSWORD=… node --conditions=react-server --import tsx apps/web/e2e/add-staff-user.ts <email> <name>
 */
import { newId } from '@studio/core';
import { createDatabase, schema } from '@studio/db';
import { hashPassword } from '../src/lib/auth-core.js';

const [email, name] = process.argv.slice(2);
const password = process.env['STAFF_PASSWORD'] ?? '';
const connectionString = process.env['DATABASE_URL'];
if (!email || !name || password.length < 10 || !connectionString) {
  console.error('Usage: DATABASE_URL=… STAFF_PASSWORD=… node --conditions=react-server --import tsx add-staff-user.ts <email> <name>');
  process.exit(2);
}
const handle = createDatabase(connectionString, { max: 1, applicationName: 'studio-e2e' });
try {
  const id = newId();
  await handle.db.insert(schema.users).values({ id, email, displayName: name, passwordHash: await hashPassword(password), role: 'staff' });
  console.log(JSON.stringify({ id }));
} finally {
  await handle.close();
}
