/** Issues Cloudflare Access-style RS256 JWTs and serves the matching JWKS for tests. */
import { webcrypto } from 'node:crypto';

const subtle = webcrypto.subtle;
const b64url = (buf: ArrayBuffer | Uint8Array) => Buffer.from(buf instanceof Uint8Array ? buf : new Uint8Array(buf)).toString('base64url');

export const TEAM_DOMAIN = 'https://team.cloudflareaccess.test';
export const ACCESS_AUD = 'aud-test-1234567890';
export const ADMIN_EMAIL = 'tutor@example.com';

export class FakeAccess {
  private constructor(
    private key: CryptoKeyPair,
    private otherKey: CryptoKeyPair,
    readonly kid: string,
    readonly jwk: JsonWebKey,
  ) {}

  static async create(): Promise<FakeAccess> {
    const params = { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' } as const;
    const key = (await subtle.generateKey(params, true, ['sign', 'verify'])) as CryptoKeyPair;
    const otherKey = (await subtle.generateKey(params, true, ['sign', 'verify'])) as CryptoKeyPair;
    const jwk = await subtle.exportKey('jwk', key.publicKey);
    return new FakeAccess(key, otherKey, 'kid-test-1', jwk);
  }

  jwks(): unknown {
    return { keys: [{ ...this.jwk, kid: this.kid, alg: 'RS256', use: 'sig' }] };
  }

  async sign(claims: Record<string, unknown> = {}, opts: { wrongKey?: boolean; kid?: string; alg?: string } = {}): Promise<string> {
    const nowSec = Math.floor(Date.now() / 1000);
    const header = { alg: opts.alg ?? 'RS256', kid: opts.kid ?? this.kid, typ: 'JWT' };
    const payload = {
      iss: TEAM_DOMAIN,
      aud: [ACCESS_AUD],
      email: ADMIN_EMAIL,
      sub: 'user-123',
      type: 'app',
      iat: nowSec - 10,
      nbf: nowSec - 10,
      exp: nowSec + 3600,
      ...claims,
    };
    const input = `${b64url(Buffer.from(JSON.stringify(header)))}.${b64url(Buffer.from(JSON.stringify(payload)))}`;
    const signer = opts.wrongKey ? this.otherKey.privateKey : this.key.privateKey;
    const sig = await subtle.sign('RSASSA-PKCS1-v1_5', signer, new TextEncoder().encode(input));
    return `${input}.${b64url(sig)}`;
  }
}
