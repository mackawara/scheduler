export type AppTenant = {
  id: string;
  slug: string;
  name: string;
  timezone: string;
  address: string | null;
  holdTtlMinutes: number;
  rescheduleCutoffHours: number;
  slotIntervalMinutes: number;
  webhookUrl: string | null;
  webhookSecretEncrypted: string | null;
};

export type AuthPrincipal =
  | { type: 'ADMIN'; id: string; appId: string; role: 'ADMIN' | 'STAFF' }
  | {
      type: 'CUSTOMER';
      id: string;
      appId: string;
      /** Set when the token was minted for a single booking via that booking's OTP. */
      appointmentId?: string;
      /** Set when the token represents the whole customer (phone OTP or account login). */
      customerId?: string;
    };

/** Which class of API key authenticated the request. */
export type KeyScope = 'PUBLIC' | 'SECRET';

declare global {
  namespace Express {
    interface Request {
      tenant?: AppTenant;
      principal?: AuthPrincipal;
      keyScope?: KeyScope;
    }
  }
}

export {};
