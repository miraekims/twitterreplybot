// AES-GCM via Node's built-in crypto. No external deps.
// Same on-disk format as the browser-side helper:
//   base64( salt[16] | iv[12] | ciphertext+tag )
import { scryptSync, randomBytes, createCipheriv, createDecipheriv } from 'node:crypto';

function deriveKey(passphrase, salt) {
  // scrypt is the Node-built-in equivalent of PBKDF2 for passphrase derivation.
  // Cost picked to be < 100ms on commodity hardware.
  return scryptSync(passphrase, salt, 32, { N: 16384, r: 8, p: 1 });
}

export function encryptJSON(passphrase, value) {
  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const key = deriveKey(passphrase, salt);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const pt = Buffer.from(JSON.stringify(value), 'utf8');
  const ct = Buffer.concat([cipher.update(pt), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([salt, iv, ct, tag]).toString('base64');
}

export function decryptJSON(passphrase, blob) {
  const buf = Buffer.from(blob, 'base64');
  const salt = buf.subarray(0, 16);
  const iv = buf.subarray(16, 28);
  const tag = buf.subarray(buf.length - 16);
  const ct = buf.subarray(28, buf.length - 16);
  const key = deriveKey(passphrase, salt);
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  const pt = Buffer.concat([decipher.update(ct), decipher.final()]);
  return JSON.parse(pt.toString('utf8'));
}
