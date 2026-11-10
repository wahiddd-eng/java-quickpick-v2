import type { Logger } from '../logger.js';

export interface PushMessage {
  title: string;
  body: string;
  /** String-only key/values (FCM data payload). Never put the pickup OTP here. */
  data: Record<string, string>;
  /** Deep link opened when the notification is tapped. */
  link?: string;
}

export type TokenResult =
  | { token: string; ok: true; messageId: string }
  | { token: string; ok: false; error: string; /** token is dead (uninstalled / unregistered) — disable it */ invalidToken: boolean; retryable: boolean };

export interface PushProvider {
  readonly name: string;
  /** True when this provider really delivers to devices (false for log/none). */
  readonly delivers: boolean;
  send(tokens: string[], msg: PushMessage): Promise<TokenResult[]>;
}

/** Sandbox provider: writes a structured log line instead of sending. Delivery rows are marked SIMULATED. */
export class LogPushProvider implements PushProvider {
  readonly name = 'log';
  readonly delivers = false;
  constructor(private log: Logger) {}
  async send(tokens: string[], msg: PushMessage): Promise<TokenResult[]> {
    this.log.info('push_simulated', { title: msg.title, tokens: tokens.length, type: msg.data.type });
    return tokens.map((token) => ({ token, ok: true as const, messageId: 'simulated' }));
  }
}

export class NoPushProvider implements PushProvider {
  readonly name = 'none';
  readonly delivers = false;
  async send(tokens: string[]): Promise<TokenResult[]> {
    return tokens.map((token) => ({ token, ok: false as const, error: 'PUSH_DISABLED', invalidToken: false, retryable: false }));
  }
}
