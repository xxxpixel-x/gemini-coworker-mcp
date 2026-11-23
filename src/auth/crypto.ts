import crypto from 'node:crypto';

export function generateId(prefix: string, byteLength = 12): string {
  return `${prefix}_${crypto.randomBytes(byteLength).toString('hex')}`;
}

export function generateRandomToken(byteLength = 32): string {
  return crypto.randomBytes(byteLength).toString('base64url');
}

export function hashToken(token: string): string {
  return crypto.createHash('sha256').update(token, 'utf8').digest('hex');
}

export function computeS256Challenge(verifier: string): string {
  return crypto.createHash('sha256').update(verifier, 'ascii').digest('base64url');
}

export function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

export function hashPasswordScrypt(password: string): string {
  const salt = crypto.randomBytes(16).toString('hex');
  const key = crypto.scryptSync(password, salt, 32, { N: 16384, r: 8, p: 1 }).toString('hex');
  return `scrypt:${salt}:${key}`;
}

export function verifyPassword(password: string, storedHash: string, allowPlain = false): boolean {
  if (!storedHash) return false;

  const scryptMatch = /^scrypt[:$]([0-9a-f]+)[:$]([0-9a-f]+)$/i.exec(storedHash);
  if (scryptMatch) {
    const [, salt, expectedHex] = scryptMatch;
    const derived = crypto
      .scryptSync(password, salt, expectedHex.length / 2, { N: 16384, r: 8, p: 1 })
      .toString('hex');
    return safeEqual(derived.toLowerCase(), expectedHex.toLowerCase());
  }

  const shaMatch = /^sha256[:$]([0-9a-f]{64})$/i.exec(storedHash);
  if (shaMatch) {
    const digest = crypto.createHash('sha256').update(password, 'utf8').digest('hex');
    return safeEqual(digest.toLowerCase(), shaMatch[1].toLowerCase());
  }

  if (allowPlain) {
    const plain = storedHash.startsWith('plain$') ? storedHash.slice(6) : storedHash;
    return safeEqual(password, plain);
  }

  return false;
}
