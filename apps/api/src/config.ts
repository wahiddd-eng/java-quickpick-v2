import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import { z } from 'zod';

const here = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(here, '../../../.env') });

const bool = (v: string | undefined, d: boolean) => (v === undefined || v === '' ? d : v === 'true' || v === '1');

export type PushProviderName = 'log' | 'fcm' | 'none';

export interface Config {
  nodeEnv: string;
  port: number;
  databaseUrl?: string;
  pgliteDataDir: string;
  jwtSecret: string;
  mockWebhookSecret: string;
  /** Key material for hashing and encrypting pickup OTPs. */
  pickupOtpSecret: string;
  corsOrigins: string[];
  /** Public base URL of this API (used in hosted sandbox checkout links). */
  publicApiUrl: string;
  /** Public base URL of the student PWA (QR codes point here; checkout return URLs must start with it). */
  studentAppUrl: string;
  paymentProvider: 'mock';
  /** Sandbox mode is always on in this build: there is no live payment adapter. */
  sandbox: true;
  otpDevEcho: boolean;
  minLeadMinutes: number;
  checkoutTtlSeconds: number;
  /** How long a READY order's pickup OTP stays valid. */
  collectionWindowMinutes: number;
  pickupOtpMaxAttempts: number;
  printMaxAttempts: number;
  /** Seconds a tablet holds a claimed print job before another device may take it over. */
  printClaimSeconds: number;
  push: {
    provider: PushProviderName;
    fcmProjectId?: string;
    fcmClientEmail?: string;
    fcmPrivateKey?: string;
  };
  smsProvider: 'none';
  sentryDsn?: string;
  logLevel: 'debug' | 'info' | 'warn' | 'error' | 'silent';
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const nodeEnv = env.NODE_ENV ?? 'development';
  const prod = nodeEnv === 'production';
  const test = nodeEnv === 'test';
  const parsed = z
    .object({
      PORT: z.coerce.number().int().default(4100),
      PAYMENT_PROVIDER: z.string().default('mock'),
      MIN_LEAD_MINUTES: z.coerce.number().int().min(0).default(5),
      CHECKOUT_TTL_SECONDS: z.coerce.number().int().min(30).default(600),
      COLLECTION_WINDOW_MINUTES: z.coerce.number().int().min(5).max(24 * 60).default(120),
      PICKUP_OTP_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(20).default(5),
      PRINT_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(10).default(3),
      PRINT_CLAIM_SECONDS: z.coerce.number().int().min(5).max(600).default(45),
      PUSH_PROVIDER: z.enum(['log', 'fcm', 'none']).default('log'),
      SMS_PROVIDER: z.enum(['none']).default('none'),
      LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error', 'silent']).optional(),
    })
    .parse(env);

  if (parsed.PAYMENT_PROVIDER !== 'mock') {
    throw new Error(
      `PAYMENT_PROVIDER="${parsed.PAYMENT_PROVIDER}" is not available. Only the sandbox "mock" provider exists until the ` +
        'payment provider, a CA and the relevant authorities have approved the transaction structure in writing.',
    );
  }
  const required = (name: string) => {
    if (prod && (!env[name] || env[name] === 'replace-me')) throw new Error(`${name} is required in production`);
  };
  required('JWT_SECRET');
  required('MOCK_WEBHOOK_SECRET');
  required('PICKUP_OTP_SECRET');
  if (parsed.PUSH_PROVIDER === 'fcm' && !(env.FCM_PROJECT_ID && env.FCM_CLIENT_EMAIL && env.FCM_PRIVATE_KEY)) {
    throw new Error('PUSH_PROVIDER=fcm needs FCM_PROJECT_ID, FCM_CLIENT_EMAIL and FCM_PRIVATE_KEY (service account)');
  }

  const secretOrRandom = (v: string | undefined) => (v && v !== 'replace-me' ? v : crypto.randomBytes(32).toString('hex'));
  // Pickup OTPs are encrypted at rest; a random key per restart would make READY orders unreadable in local dev.
  const otpSecret = env.PICKUP_OTP_SECRET && env.PICKUP_OTP_SECRET !== 'replace-me' ? env.PICKUP_OTP_SECRET : 'dev-only-pickup-otp-secret-not-for-production';

  return {
    nodeEnv,
    port: parsed.PORT,
    databaseUrl: env.DATABASE_URL || undefined,
    pgliteDataDir: env.PGLITE_DATA_DIR || '.data/pglite-v2',
    jwtSecret: secretOrRandom(env.JWT_SECRET),
    mockWebhookSecret: secretOrRandom(env.MOCK_WEBHOOK_SECRET),
    pickupOtpSecret: otpSecret,
    corsOrigins: (env.CORS_ORIGINS ?? 'http://localhost:5273,http://localhost:5274,http://localhost:5275,capacitor://localhost,https://localhost')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
    publicApiUrl: (env.PUBLIC_API_URL || `http://localhost:${parsed.PORT}`).replace(/\/$/, ''),
    studentAppUrl: (env.STUDENT_APP_URL || 'http://localhost:5273').replace(/\/$/, ''),
    paymentProvider: 'mock',
    sandbox: true,
    otpDevEcho: bool(env.OTP_DEV_ECHO, !prod),
    minLeadMinutes: parsed.MIN_LEAD_MINUTES,
    checkoutTtlSeconds: parsed.CHECKOUT_TTL_SECONDS,
    collectionWindowMinutes: parsed.COLLECTION_WINDOW_MINUTES,
    pickupOtpMaxAttempts: parsed.PICKUP_OTP_MAX_ATTEMPTS,
    printMaxAttempts: parsed.PRINT_MAX_ATTEMPTS,
    printClaimSeconds: parsed.PRINT_CLAIM_SECONDS,
    push: {
      provider: parsed.PUSH_PROVIDER,
      fcmProjectId: env.FCM_PROJECT_ID || undefined,
      fcmClientEmail: env.FCM_CLIENT_EMAIL || undefined,
      fcmPrivateKey: env.FCM_PRIVATE_KEY ? env.FCM_PRIVATE_KEY.replace(/\\n/g, '\n') : undefined,
    },
    smsProvider: parsed.SMS_PROVIDER,
    sentryDsn: env.SENTRY_DSN || undefined,
    logLevel: parsed.LOG_LEVEL ?? (test ? 'silent' : 'info'),
  };
}
