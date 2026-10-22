// Makes the key pair for desktop-app licences. Run ONCE:  node scripts/make-license-key.mjs
//  - PB_LICENSE_KEY (private): paste into Netlify → Site configuration → Environment variables.
//    Keep it secret and never change it: every licence already issued is signed with it.
//  - Public key: goes into the desktop app (it only checks licences, it can't make them).
import { generateKeyPairSync } from 'node:crypto';
const { privateKey, publicKey } = generateKeyPairSync('ed25519');
const priv = privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64');
const pubDer = publicKey.export({ format: 'der', type: 'spki' });
console.log('\nPB_LICENSE_KEY (private, Netlify environment variable, keep secret):\n\n' + priv + '\n');
console.log('Public key for the desktop app (SPKI, base64):\n\n' + pubDer.toString('base64') + '\n');
console.log('Public key (raw, hex):\n\n' + pubDer.subarray(pubDer.length - 32).toString('hex') + '\n');
