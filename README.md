# Scheduler API

A multi-tenant scheduling service built with TypeScript, Express, MongoDB, Redis, and Winston. It replaces the fragile Cal.com integration with an API that can serve Beauty Naomi first and isolate additional apps behind separate credentials and scheduling policies.

## What is implemented

- Per-app API keys, data isolation, timezone, hold TTL, reschedule cutoff, and slot interval
- Admin JWT authentication with `ADMIN`/`STAFF` roles
- Dynamic service duration (`baseDurationMinutes + bufferDurationMinutes`)
- Recurring staff working hours and one-off blocked slots
- Gap-based availability in the app's IANA timezone; stored timestamps remain UTC
- Five-minute holds, idempotent hold creation, confirmation, soft cancellation, and atomic rescheduling
- Guest checkout using a phone number or social handle
- Customer OTP authorization for cancellation and rescheduling
- Waitlist release events after cancellation
- Encrypted customer/OTP/webhook-secret payloads using AES-256-GCM
- Transactional notification outbox with 24-hour and 2-hour reminders and 1/5/15-minute retries
- Immutable audit records and structured Winston logs with sensitive-field redaction
- Redis availability caching and distributed locks, with MongoDB remaining authoritative

## Double-booking protection in MongoDB

MongoDB has no native exclusion constraint for overlapping date ranges. This project therefore creates one `slotclaims` document for every occupied minute. A unique index on `(appId, staffId, minute)` means overlapping holds, bookings, or blocked slots cannot both commit. The claims and appointment are written in the same MongoDB transaction.

Redis reduces contention and caches availability for 15 seconds. If Redis is unavailable, writes remain safe because the MongoDB unique index is the final integrity boundary.

## Local setup

Requirements: Node.js 22+, Docker, and Docker Compose.

```bash
npm install
cp .env.example .env
```

Generate secrets and place them in `.env`:

```bash
openssl rand -base64 32
openssl rand -base64 32
```

Start a single-node MongoDB replica set (transactions require it) and Redis:

```bash
docker compose up -d
```

Edit [config/beauty-naomi.seed.json](./config/beauty-naomi.seed.json) with the confirmed salon address, catalog, prices, staff, and working hours. The included Hair Wash entry is only a starter based on the supplied specification. Set each service's `catalogRetailerId` to the **Content ID / retailer ID** of the matching product in the WhatsApp (Meta Commerce) catalog so the chatbot can map catalog orders to scheduler services.

```bash
BEAUTY_NAOMI_ADMIN_PASSWORD='replace-with-a-strong-password' npm run seed:beauty-naomi
npm run dev
```

Run the notification/hold-expiry worker in a second terminal:

```bash
npm run worker
```

The seed prints the Beauty Naomi API key once. Save it in the chatbot as `SCHEDULER_API_KEY`; do not commit it. A ready-to-copy TypeScript adapter is in [examples/beauty-naomi-scheduler-client.ts](./examples/beauty-naomi-scheduler-client.ts).

## Booking flow

All `/api/*` application routes require `x-api-key`.

1. `GET /api/services` (optionally `?catalogRetailerId=<WhatsApp product retailer id>` to resolve a catalog order to a service)
2. `GET /api/staff?serviceId=<id>` (optional; skip it for "any available staff")
3. `GET /api/slots/available?serviceId=<id>&date=2026-09-01[&staffId=<id>]`
4. `POST /api/bookings/hold` with an `idempotency-key` header
5. `POST /api/bookings/confirm`

### Upcoming dates with availability

`GET /api/availability/dates?serviceId=<id>[&from=YYYY-MM-DD][&days=14][&staffId=<id>][&includeEmpty=true]`

Returns `{ timezone, from, days, service, dates: [{ date, availableSlots }] }` for consecutive local dates in the app timezone (`from` defaults to today, `days` defaults to 14, maximum 31). Only dates with at least one open slot are returned unless `includeEmpty=true`. Each day reuses the cached day availability, so blocks, holds and bookings invalidate it.

### Any available staff

`staffId` is optional on both `GET /api/slots/available` and `POST /api/bookings/hold`.

- Without it, availability is the union of every active staff member whose `resourceType` matches the service, de-duplicated by start time; each slot lists the free staff in `staffIds`.
- A hold without `staffId` assigns the compatible staff member with the fewest bookings that day who is still free (ties by name), retrying the next candidate if one is taken concurrently. The response contains the assigned `staffId`. Re-sending the same `idempotency-key` returns the original hold.

Example hold:

```bash
curl -X POST http://localhost:4100/api/bookings/hold \
  -H "content-type: application/json" \
  -H "x-api-key: $SCHEDULER_API_KEY" \
  -H "idempotency-key: whatsapp-message-or-click-id" \
  -d '{
    "staffId": "<staff-object-id>",
    "serviceId": "<service-object-id>",
    "slotStartTime": "2026-09-01T09:00:00+02:00",
    "customer": {"name":"Customer", "phone":"+263..."}
  }'
```

Confirm with `{ "holdId": "...", "paymentReference": "..." }`. Payment tokens are deliberately never persisted.

## Customer self-service

Request and verify an OTP:

- `POST /api/bookings/:id/otp/request`
- `POST /api/bookings/:id/otp/verify` with `{ "code": "123456" }`

Verification returns a 15-minute booking-scoped bearer token. Send that token together with the app API key to:

- `POST /api/bookings/:id/cancel`
- `PATCH /api/bookings/:id/reschedule`

Set `DEV_EXPOSE_OTP=true` only for local development. In production, OTP values are sent through the configured notification webhook and never returned by the API.

## Admin flow

Login with `POST /api/admin/auth/login` and `{ appSlug, email, password }`. Use the returned bearer token for:

- `POST /api/admin/services`
- `POST /api/admin/staff`
- `PUT /api/admin/staff/:id/working-hours`
- `POST /api/admin/block-slot`
- `DELETE /api/admin/block-slot/:id`
- `GET /api/admin/bookings?from=<ISO>&to=<ISO>`

Create another isolated app from the command line:

```bash
APP_ADMIN_PASSWORD='replace-with-a-strong-password' npm run app:create -- \
  --slug another-app \
  --name "Another App" \
  --timezone Africa/Harare \
  --admin-email admin@example.com \
  --webhook-url https://example.com/scheduler-events
```

## Notification webhooks

The worker sends JSON events such as `BOOKING_CREATED`, `BOOKING_RESCHEDULED`, `BOOKING_CANCELLED`, `WAITLIST_SPOT_OPEN`, `REMINDER_24H`, `REMINDER_2H`, and `BOOKING_OTP_REQUESTED`.

Requests include:

- `x-scheduler-event-id`: stable event ID for consumer idempotency
- `x-scheduler-signature`: `sha256=<HMAC-SHA256 of the raw body>`

The consumer should verify the signature before processing, then use the appointment ID and its app API key to call `GET /api/bookings/:id` when it needs the encrypted-at-rest customer and booking details.

## Verification

```bash
npm run typecheck
npm test
npm run build
```

For production, use a managed MongoDB replica set, managed Redis, TLS, secret management, multiple API/worker instances, webhook monitoring, and backups. Redis is optional for correctness but recommended for throughput.
