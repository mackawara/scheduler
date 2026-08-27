type SchedulerClientOptions = { baseUrl: string; apiKey: string };

export class BeautyNaomiSchedulerClient {
  constructor(private readonly options: SchedulerClientOptions) {}

  private async request<T>(path: string, init?: RequestInit): Promise<T> {
    const response = await fetch(`${this.options.baseUrl}${path}`, {
      ...init,
      headers: {
        'content-type': 'application/json',
        'x-api-key': this.options.apiKey,
        ...init?.headers,
      },
    });
    const payload = (await response.json()) as { data?: T; error?: { code: string; message: string } };
    if (!response.ok || !payload.data) {
      throw new Error(payload.error ? `${payload.error.code}: ${payload.error.message}` : `HTTP ${response.status}`);
    }
    return payload.data;
  }

  listServices() {
    return this.request<Array<{ id: string; name: string; baseDurationMinutes: number; bufferDurationMinutes: number }>>(
      '/api/services',
    );
  }

  listStaff(serviceId: string) {
    return this.request<Array<{ id: string; name: string }>>(
      `/api/staff?serviceId=${encodeURIComponent(serviceId)}`,
    );
  }

  availableSlots(staffId: string, serviceId: string, date: string) {
    const query = new URLSearchParams({ staffId, serviceId, date });
    return this.request<{ slots: Array<{ start: string; localStart: string }> }>(
      `/api/slots/available?${query}`,
    );
  }

  hold(input: {
    staffId: string;
    serviceId: string;
    slotStartTime: string;
    customer: { name?: string; phone?: string; socialHandle?: string };
    idempotencyKey: string;
  }) {
    return this.request<{ id: string; status: 'HOLD'; holdExpiresAt: string }>('/api/bookings/hold', {
      method: 'POST',
      headers: { 'idempotency-key': input.idempotencyKey },
      body: JSON.stringify({
        staffId: input.staffId,
        serviceId: input.serviceId,
        slotStartTime: input.slotStartTime,
        customer: input.customer,
      }),
    });
  }

  confirm(holdId: string, paymentReference?: string) {
    return this.request<{ id: string; status: 'BOOKED' }>('/api/bookings/confirm', {
      method: 'POST',
      body: JSON.stringify({ holdId, paymentReference }),
    });
  }
}
