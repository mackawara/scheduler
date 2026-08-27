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
  | { type: 'CUSTOMER'; id: string; appId: string; appointmentId: string };

declare global {
  namespace Express {
    interface Request {
      tenant?: AppTenant;
      principal?: AuthPrincipal;
    }
  }
}

export {};
