// Creates a local .env with fresh push keys and an invite code. Never overwrites an existing one.

import { randomBytes } from 'node:crypto';
import { existsSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import webpush from 'web-push';

const file = join(dirname(fileURLToPath(import.meta.url)), '../.env');

if (existsSync(file)) {
  console.log('.env already exists, so nothing was changed.');
  process.exit(0);
}

const { publicKey, privateKey } = webpush.generateVAPIDKeys();
writeFileSync(
  file,
  `OPENAI_API_KEY=
INVITE_CODE=${randomBytes(6).toString('base64url')}
VAPID_PUBLIC_KEY=${publicKey}
VAPID_PRIVATE_KEY=${privateKey}
`,
  { mode: 0o600 },
);
console.log('Created .env. Add your OPENAI_API_KEY to it, then run: npm start');
