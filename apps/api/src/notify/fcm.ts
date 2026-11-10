import crypto from 'node:crypto';
import type { PushMessage, PushProvider, TokenResult } from './push.js';

/**
 * Firebase Cloud Messaging HTTP v1 adapter using a service-account key (no Firebase SDK dependency).
 * Auth: a self-signed RS256 JWT is exchanged for an OAuth access token (scope firebase.messaging), cached until expiry.
 *
 * Tested against a fake HTTP endpoint only (see apps/api/test). It has NOT been run against a real Firebase project:
 * set PUSH_PROVIDER=fcm with real credentials and verify on a device before relying on it.
 */
export interface FcmOptions {
  projectId: string;
  clientEmail: string;
  privateKey: string;
  fetch?: typeof fetch;
  tokenUrl?: string;
  apiBase?: string;
  now?: () => number;
}

const b64url = (b: Buffer | string) => Buffer.from(b).toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');

export class FcmPushProvider implements PushProvider {
  readonly name = 'fcm';
  readonly delivers = true;
  private access: { token: string; exp: number } | null = null;
  private readonly fetchFn: typeof fetch;
  private readonly tokenUrl: string;
  private readonly apiBase: string;
  private readonly now: () => number;

  constructor(private opts: FcmOptions) {
    this.fetchFn = opts.fetch ?? fetch;
    this.tokenUrl = opts.tokenUrl ?? 'https://oauth2.googleapis.com/token';
    this.apiBase = opts.apiBase ?? 'https://fcm.googleapis.com';
    this.now = opts.now ?? (() => Date.now());
  }

  private async accessToken(): Promise<string> {
    const nowS = Math.floor(this.now() / 1000);
    if (this.access && this.access.exp - 60 > nowS) return this.access.token;
    const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
    const claims = b64url(
      JSON.stringify({ iss: this.opts.clientEmail, scope: 'https://www.googleapis.com/auth/firebase.messaging', aud: this.tokenUrl, iat: nowS, exp: nowS + 3600 }),
    );
    const signature = b64url(crypto.createSign('RSA-SHA256').update(`${header}.${claims}`).sign(this.opts.privateKey));
    const res = await this.fetchFn(this.tokenUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: `${header}.${claims}.${signature}` }).toString(),
    });
    if (!res.ok) throw new Error(`FCM auth failed (${res.status})`);
    const j: any = await res.json();
    this.access = { token: j.access_token, exp: nowS + Number(j.expires_in ?? 3600) };
    return this.access.token;
  }

  async send(tokens: string[], msg: PushMessage): Promise<TokenResult[]> {
    let bearer: string;
    try {
      bearer = await this.accessToken();
    } catch (e: any) {
      return tokens.map((token) => ({ token, ok: false as const, error: e?.message ?? 'auth_failed', invalidToken: false, retryable: true }));
    }
    const url = `${this.apiBase}/v1/projects/${encodeURIComponent(this.opts.projectId)}/messages:send`;
    const results: TokenResult[] = [];
    for (const token of tokens) {
      const body = {
        message: {
          token,
          notification: { title: msg.title, body: msg.body },
          data: msg.data,
          webpush: msg.link ? { fcm_options: { link: msg.link } } : undefined,
          android: { priority: 'HIGH' },
        },
      };
      try {
        const res = await this.fetchFn(url, { method: 'POST', headers: { Authorization: `Bearer ${bearer}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
        const j: any = await res.json().catch(() => ({}));
        if (res.ok) {
          results.push({ token, ok: true, messageId: String(j.name ?? '') });
          continue;
        }
        const code: string = j?.error?.details?.find?.((d: any) => d.errorCode)?.errorCode ?? j?.error?.status ?? `HTTP_${res.status}`;
        const invalid = code === 'UNREGISTERED' || code === 'INVALID_ARGUMENT' || res.status === 404;
        const retryable = !invalid && (res.status === 429 || res.status >= 500 || code === 'UNAVAILABLE' || code === 'INTERNAL');
        results.push({ token, ok: false, error: code, invalidToken: invalid, retryable });
      } catch (e: any) {
        results.push({ token, ok: false, error: e?.message ?? 'network_error', invalidToken: false, retryable: true });
      }
    }
    return results;
  }
}
