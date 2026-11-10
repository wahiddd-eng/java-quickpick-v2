import crypto from 'node:crypto';
import {
  WebhookSignatureError,
  type CheckoutSession,
  type CreateCheckoutInput,
  type CreateRefundInput,
  type MarketplacePaymentProvider,
  type ProviderPaymentStatus,
  type RefundResult,
  type SettlementReport,
  type SplitInput,
  type SplitResult,
  type VendorAccountInput,
  type VendorAccountResult,
  type VerifiedWebhookEvent,
  type VerifyWebhookInput,
  type WebhookEventType,
} from './provider.js';

export const MOCK_SIGNATURE_HEADER = 'x-mock-signature';

export function signMockBody(secret: string, body: Buffer | string): string {
  return crypto.createHmac('sha256', secret).update(body).digest('hex');
}

/**
 * SANDBOX provider. Takes no money, talks to no network. It has a hosted checkout page (served by our API under
 * /sandbox/checkout/:session) and HMAC-SHA256-signed webhooks over the raw body, so the verification path (raw body +
 * constant-time compare + dedupe + amount/currency/order checks) is exercised exactly as a real provider's would be.
 */
export class MockPaymentProvider implements MarketplacePaymentProvider {
  readonly name = 'mock';
  private readonly statuses = new Map<string, ProviderPaymentStatus>();
  private refundOutcome: 'refund.processed' | 'refund.failed' = 'refund.processed';

  constructor(
    private readonly secret: string,
    private readonly publicApiUrl: string,
  ) {}

  async createCheckout(input: CreateCheckoutInput): Promise<CheckoutSession> {
    // Deterministic per order so retrying checkout never creates a second provider order.
    const providerRef = 'mock_ord_' + crypto.createHash('sha256').update(input.idempotencyKey).digest('hex').slice(0, 24);
    // A new attempt after a failure is pending again at the provider; a captured payment stays captured.
    if (this.statuses.get(providerRef) !== 'SUCCEEDED') this.statuses.set(providerRef, 'PENDING');
    const sessionRef = 'mock_ses_' + crypto.randomBytes(12).toString('hex');
    return { providerRef, sessionRef, checkoutUrl: `${this.publicApiUrl}/sandbox/checkout/${sessionRef}` };
  }

  async verifyWebhook({ rawBody, headers }: VerifyWebhookInput): Promise<VerifiedWebhookEvent> {
    const header = headers[MOCK_SIGNATURE_HEADER];
    const sig = Array.isArray(header) ? header[0] : header;
    if (!sig || !/^[0-9a-f]{64}$/i.test(sig)) throw new WebhookSignatureError();
    const expected = Buffer.from(signMockBody(this.secret, rawBody), 'hex');
    const given = Buffer.from(sig, 'hex');
    if (expected.length !== given.length || !crypto.timingSafeEqual(expected, given)) throw new WebhookSignatureError();

    let body: any;
    try {
      body = JSON.parse(rawBody.toString('utf8'));
    } catch {
      throw new WebhookSignatureError('Malformed webhook body');
    }
    const types: WebhookEventType[] = ['payment.succeeded', 'payment.failed', 'refund.processed', 'refund.failed'];
    if (typeof body?.id !== 'string' || !types.includes(body?.type) || typeof body?.data?.providerRef !== 'string') {
      throw new WebhookSignatureError('Unrecognised webhook payload');
    }
    if (body.type === 'payment.succeeded') this.statuses.set(body.data.providerRef, 'SUCCEEDED');
    if (body.type === 'payment.failed' && this.statuses.get(body.data.providerRef) !== 'SUCCEEDED') this.statuses.set(body.data.providerRef, 'FAILED');
    return {
      externalId: body.id,
      type: body.type,
      providerRef: body.data.providerRef,
      amountPaise: typeof body.data.amountPaise === 'number' ? body.data.amountPaise : undefined,
      currency: typeof body.data.currency === 'string' ? body.data.currency : undefined,
      orderId: typeof body.data.orderId === 'string' ? body.data.orderId : undefined,
      reason: typeof body.data.reason === 'string' ? body.data.reason : undefined,
      raw: body,
    };
  }

  async getPaymentStatus(providerPaymentRef: string): Promise<ProviderPaymentStatus> {
    return this.statuses.get(providerPaymentRef) ?? 'PENDING';
  }

  async createRefund(input: CreateRefundInput): Promise<RefundResult> {
    const providerRef = 'mock_rfnd_' + crypto.createHash('sha256').update(input.idempotencyKey).digest('hex').slice(0, 24);
    return { providerRef, status: 'PENDING' };
  }

  async createOrUpdateVendorAccount(input: VendorAccountInput): Promise<VendorAccountResult> {
    return { accountRef: `mock_acct_${input.shopId}` };
  }

  async createSplitOrTransfer(input: SplitInput): Promise<SplitResult> {
    return { providerRef: `mock_split_${input.providerPaymentRef}`, status: 'PLANNED' };
  }

  async getSettlementReport(): Promise<SettlementReport> {
    return { lines: [] };
  }

  sandboxRefundOutcome(): 'refund.processed' | 'refund.failed' {
    return this.refundOutcome;
  }

  // ----- sandbox controls (tests and the hosted sandbox checkout page) -----

  /** Make subsequent refunds fail (to exercise the refund-failure path). */
  setRefundOutcome(o: 'refund.processed' | 'refund.failed') {
    this.refundOutcome = o;
  }

  /** Mark a payment captured at the "provider" WITHOUT sending a webhook (lost webhook / closed browser). */
  markPaidWithoutWebhook(providerRef: string) {
    this.statuses.set(providerRef, 'SUCCEEDED');
  }

  /** Build a correctly signed webhook (body + signature header). */
  buildSignedEvent(event: { id: string; type: WebhookEventType; providerRef: string; amountPaise?: number; currency?: string; orderId?: string; reason?: string }) {
    const body = Buffer.from(
      JSON.stringify({
        id: event.id,
        type: event.type,
        data: { providerRef: event.providerRef, amountPaise: event.amountPaise, currency: event.currency, orderId: event.orderId, reason: event.reason },
      }),
    );
    return { body, headers: { [MOCK_SIGNATURE_HEADER]: signMockBody(this.secret, body) } };
  }
}
