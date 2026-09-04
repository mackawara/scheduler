# Scheduler API

A multi-tenant scheduling service built with TypeScript, Express, MongoDB, Redis, and Winston. It replaces the fragile Cal.com integration with an API that can serve Beauty Naomi first and isolate additional apps behind separate credentials and scheduling policies.

## What is implemented

- Per-app secret and publishable API keys, data isolation, timezone, hold TTL, reschedule cutoff, and slot interval
- Admin JWT authentication with `ADMIN`/`STAFF` roles
- Dynamic service duration (`baseDurationMinutes + bufferDurationMinutes`)
- Recurring staff working hours and one-off blocked slots
- Gap-based availability in the app's IANA timezone; stored timestamps remain UTC
- Five-minute holds, idempotent hold creation, confirmation, soft cancellation, and atomic rescheduling
- Guest checkout using a phone number or social handle
- Optional customer accounts that adopt guest bookings already made against the same phone number
- "Any available" search that merges availability across every qualified staff member, with automatic assignment at hold time
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

Edit [config/beauty-naomi.seed.json](./config/beauty-naomi.seed.json) with the confirmed salon address, catalog, prices, staff, and working hours. The included Hair Wash entry is only a starter based on the supplied specification.

```bash
BEAUTY_NAOMI_ADMIN_PASSWORD='replace-with-a-strong-password' npm run seed:beauty-naomi
npm run dev
```

Run the notification/hold-expiry worker in a second terminal:

```bash
npm run worker
```

The seed prints the Beauty Naomi keys once. Save the secret key in the chatbot as `SCHEDULER_API_KEY` and the publishable key in the portal as `VITE_SCHEDULER_PUBLIC_KEY`; do not commit either. A ready-to-copy TypeScript adapter is in [examples/beauty-naomi-scheduler-client.ts](./examples/beauty-naomi-scheduler-client.ts).

## API keys

Every app gets two keys:

| Key | Prefix | Where it belongs |
| --- | --- | --- |
| Secret | `sk_sched_` | Servers only — the chatbot, backend jobs. Grants every `/api/*` route. |
| Publishable | `pk_sched_` | Safe to ship in a browser bundle. Grants the catalog, availability, booking-creation, and customer self-service routes. |

`GET /api/bookings/:id` returns decrypted customer details, so it rejects publishable keys with `SECRET_KEY_REQUIRED`. A browser reads a customer's own bookings through `GET /api/customers/me/bookings` instead, which requires a token the customer proved they own.

Both keys are printed once by the seed and `app:create` scripts. Re-run the seed with `ROTATE_PUBLIC_KEY=true` to back-fill or rotate a publishable key.

## Booking flow

All `/api/*` application routes require `x-api-key`.

1. `GET /api/services`
2. `GET /api/staff?serviceId=<id>` — only when the customer picks a stylist up front
3. Availability, either:
   - `GET /api/slots/search?serviceId=<id>&date=2026-09-01` for every qualified stylist at once, each slot listing who is free; add `&staffId=<id>` to narrow it, or
   - `GET /api/slots/available?staffId=<id>&serviceId=<id>&date=2026-09-01` for one stylist
4. `POST /api/bookings/hold` with an `idempotency-key` header. Omit `staffId` to let the scheduler assign the least-loaded qualified stylist for that slot.
5. `POST /api/bookings/confirm`

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

There are two ways for a customer to prove who they are. Both accept a publishable key, so the portal can run them straight from the browser.

**Per booking**, when they already have a booking reference:

- `POST /api/bookings/:id/otp/request`
- `POST /api/bookings/:id/otp/verify` with `{ "code": "123456" }`

Verification returns a 15-minute booking-scoped bearer token.

**Per customer**, to find every booking behind a phone number — the same identity a WhatsApp booking uses, so a booking made in either channel is manageable in both:

- `POST /api/customers/otp/request` with `{ "phone": "+263..." }`
- `POST /api/customers/otp/verify` with `{ "phone": "+263...", "code": "123456" }`

Verification returns a 30-minute customer-scoped token. The request endpoint answers identically for known and unknown numbers, so it cannot be used to enumerate customers; only a number already on file is sent a code.

Customers may also register an account. Registering with a phone number that already has guest bookings adopts that history rather than creating a second record:

- `POST /api/customers/register` with `{ name, email, password, phone }`
- `POST /api/customers/login` with `{ email, password }`
- `GET /api/customers/me`
- `GET /api/customers/me/bookings?includePast=true`

Send either customer token together with the app key to:

- `POST /api/bookings/:id/cancel`
- `PATCH /api/bookings/:id/reschedule`

A customer-scoped token is checked against the booking's owner, so it can only manage that customer's own bookings.

Set `DEV_EXPOSE_OTP=true` only for local development. In production, OTP values are sent through the configured notification webhook and never returned by the API.

## Admin flow

Login with `POST /api/admin/auth/login` and `{ appSlug, email, password }`. Use the returned bearer token for:

- `POST /api/admin/services`
- `POST /api/admin/staff`
- `PUT /api/admin/staff/:id/working-hours`
- `POST /api/admin/block-slot`
- `DELETE /api/admin/block-slot/:id`
- `GET /api/admin/services`
- `GET /api/admin/staff`
- `GET /api/admin/bookings?from=<ISO>&to=<ISO>`
- `GET /api/admin/bookings/:id`
- `GET /api/admin/bookings/:id/reschedule-options?date=<YYYY-MM-DD>`
- `POST /api/admin/bookings/:id/cancel`
- `PATCH /api/admin/bookings/:id/reschedule`

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

The worker sends JSON events such as `BOOKING_CREATED`, `BOOKING_RESCHEDULED`, `BOOKING_CANCELLED`, `WAITLIST_SPOT_OPEN`, `REMINDER_24H`, `REMINDER_2H`, `BOOKING_OTP_REQUESTED`, and `CUSTOMER_OTP_REQUESTED`.

`BOOKING_OTP_REQUESTED` and `CUSTOMER_OTP_REQUESTED` carry the six-digit code in the encrypted portion of the payload; the consumer is responsible for delivering it to the customer.

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
