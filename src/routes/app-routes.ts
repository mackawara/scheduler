import { Router } from 'express';
import { z } from 'zod';
import { env } from '../config.js';
import { withMongoTransaction } from '../db.js';
import { encryptJson } from '../lib/crypto.js';
import { HttpError, notFound } from '../lib/errors.js';
import { apiKeyAuth, bookingManagementAuth, customerAuth, customerIdOf, requireSecretKey } from '../middleware/auth.js';
import { AuditLogModel, ServiceModel, StaffModel, WaitlistModel } from '../models.js';
import { getAvailability } from '../services/availability-service.js';
import {
  cancelBooking,
  confirmHold,
  createHold,
  getBooking,
  requestBookingOtp,
  rescheduleBooking,
  verifyBookingOtp,
} from '../services/booking-service.js';
import {
  assertBookingOwnedByCustomer,
  getCustomerProfile,
  listCustomerBookings,
  loginCustomer,
  registerCustomer,
  requestCustomerOtp,
  verifyCustomerOtp,
} from '../services/customer-service.js';
import { searchSlots } from '../services/slot-search-service.js';

const uuid = z.string().regex(/^[a-f\d]{24}$/i, 'Must be a MongoDB ObjectId');
const isoTimestamp = z.iso.datetime({ offset: true });
const phone = z.string().trim().min(5).max(30);
const guest = z
  .object({
    name: z.string().trim().min(1).max(120).optional(),
    phone: z.string().trim().min(5).max(30).optional(),
    socialHandle: z.string().trim().min(2).max(120).optional(),
  })
  .refine((value) => value.phone || value.socialHandle, {
    message: 'A phone number or social handle is required',
  });

export const appRoutes = Router();
appRoutes.use(apiKeyAuth);

appRoutes.get('/services', async (req, res) => {
  const services = await ServiceModel.find({ appId: req.tenant!.id, active: true }).sort({ name: 1 }).lean();
  res.json({
    data: services.map((service) => ({
      id: service._id.toString(),
      name: service.name,
      description: service.description,
      baseDurationMinutes: service.baseDurationMinutes,
      bufferDurationMinutes: service.bufferDurationMinutes,
      resourceType: service.resourceType,
      priceCents: service.priceCents,
      currency: service.currency,
    })),
  });
});

appRoutes.get('/staff', async (req, res) => {
  const query = z.object({ serviceId: uuid.optional() }).parse(req.query);
  let resourceType: string | undefined;
  if (query.serviceId) {
    const service = await ServiceModel.findOne({ _id: query.serviceId, appId: req.tenant!.id, active: true }).lean();
    if (!service) throw notFound('Service');
    resourceType = service.resourceType;
  }
  const staff = await StaffModel.find({
    appId: req.tenant!.id,
    active: true,
    ...(resourceType ? { resourceType } : {}),
  })
    .sort({ name: 1 })
    .lean();
  res.json({ data: staff.map((member) => ({ id: member._id.toString(), name: member.name, resourceType: member.resourceType })) });
});

appRoutes.get('/slots/available', async (req, res) => {
  const query = z.object({ staffId: uuid, serviceId: uuid, date: z.iso.date() }).parse(req.query);
  res.json({ data: await getAvailability(req.tenant!, query) });
});

/**
 * Availability across every staff member who can perform the service. Pass
 * staffId to narrow it to one stylist; omit it to browse "any available".
 */
appRoutes.get('/slots/search', async (req, res) => {
  const query = z.object({ serviceId: uuid, date: z.iso.date(), staffId: uuid.optional() }).parse(req.query);
  res.json({ data: await searchSlots(req.tenant!, query) });
});

appRoutes.post('/bookings/hold', async (req, res) => {
  const body = z
    .object({ staffId: uuid.optional(), serviceId: uuid, slotStartTime: isoTimestamp, customer: guest })
    .parse(req.body);
  const idempotencyKey = z.string().trim().min(8).max(200).parse(req.get('idempotency-key'));
  res.status(201).json({ data: await createHold(req.tenant!, { ...body, idempotencyKey }) });
});

appRoutes.post('/bookings/confirm', async (req, res) => {
  const body = z
    .object({
      holdId: uuid,
      paymentReference: z.string().trim().max(200).optional(),
      paymentToken: z.string().optional(),
    })
    .parse(req.body);
  res.json({
    data: await confirmHold(req.tenant!, { holdId: body.holdId, paymentReference: body.paymentReference }),
  });
});

// Returns decrypted customer details, so a publishable key is never enough.
appRoutes.get('/bookings/:id', requireSecretKey, async (req, res) => {
  res.json({ data: await getBooking(req.tenant!, uuid.parse(req.params.id)) });
});

appRoutes.post('/bookings/:id/otp/request', async (req, res) => {
  res.status(202).json({ data: await requestBookingOtp(req.tenant!, uuid.parse(req.params.id)) });
});

appRoutes.post('/bookings/:id/otp/verify', async (req, res) => {
  const bookingId = uuid.parse(req.params.id);
  const body = z.object({ code: z.string().regex(/^\d{6}$/) }).parse(req.body);
  res.json({ data: await verifyBookingOtp(req.tenant!, bookingId, body.code) });
});

/** A customer-wide token may only touch bookings that belong to that customer. */
async function assertPrincipalOwnsBooking(req: Parameters<typeof bookingManagementAuth>[0], bookingId: string) {
  const principal = req.principal!;
  if (principal.type === 'CUSTOMER' && principal.customerId) {
    await assertBookingOwnedByCustomer(req.tenant!, bookingId, principal.customerId);
  }
}

appRoutes.post('/bookings/:id/cancel', bookingManagementAuth, async (req, res) => {
  const bookingId = uuid.parse(req.params.id);
  const body = z.object({ reason: z.string().trim().max(300).optional() }).parse(req.body);
  await assertPrincipalOwnsBooking(req, bookingId);
  res.json({ data: await cancelBooking(req.tenant!, bookingId, req.principal!, body.reason) });
});

appRoutes.patch('/bookings/:id/reschedule', bookingManagementAuth, async (req, res) => {
  const bookingId = uuid.parse(req.params.id);
  const body = z.object({ newSlotStartTime: isoTimestamp }).parse(req.body);
  await assertPrincipalOwnsBooking(req, bookingId);
  res.json({
    data: await rescheduleBooking(req.tenant!, bookingId, req.principal!, body.newSlotStartTime),
  });
});

/**
 * Customer self-service. A customer proves who they are either with a code sent
 * to their phone — the same identity WhatsApp bookings use — or with an account
 * password. Both mint the same customer-scoped token.
 */
appRoutes.post('/customers/otp/request', async (req, res) => {
  const body = z.object({ phone }).parse(req.body);
  res.status(202).json({ data: await requestCustomerOtp(req.tenant!, body.phone) });
});

appRoutes.post('/customers/otp/verify', async (req, res) => {
  const body = z.object({ phone, code: z.string().regex(/^\d{6}$/) }).parse(req.body);
  res.json({ data: await verifyCustomerOtp(req.tenant!, body.phone, body.code) });
});

appRoutes.post('/customers/register', async (req, res) => {
  const body = z
    .object({
      name: z.string().trim().min(1).max(120),
      email: z.email(),
      password: z.string().min(8).max(200),
      phone,
    })
    .parse(req.body);
  res.status(201).json({ data: await registerCustomer(req.tenant!, body) });
});

appRoutes.post('/customers/login', async (req, res) => {
  const body = z.object({ email: z.email(), password: z.string().min(1).max(200) }).parse(req.body);
  res.json({ data: await loginCustomer(req.tenant!, body) });
});

appRoutes.get('/customers/me', customerAuth, async (req, res) => {
  res.json({ data: await getCustomerProfile(req.tenant!, customerIdOf(req)) });
});

appRoutes.get('/customers/me/bookings', customerAuth, async (req, res) => {
  const query = z.object({ includePast: z.enum(['true', 'false']).optional() }).parse(req.query);
  res.json({
    data: await listCustomerBookings(req.tenant!, customerIdOf(req), {
      includePast: query.includePast === 'true',
    }),
  });
});

appRoutes.post('/waitlist', async (req, res) => {
  const body = z
    .object({ staffId: uuid, serviceId: uuid.optional(), date: z.iso.date(), customer: guest })
    .parse(req.body);
  const id = await withMongoTransaction(async (session) => {
    const staff = await StaffModel.exists({ _id: body.staffId, appId: req.tenant!.id, active: true }).session(session);
    const service = body.serviceId
      ? await ServiceModel.exists({ _id: body.serviceId, appId: req.tenant!.id, active: true }).session(session)
      : true;
    if (!staff) throw notFound('Staff member');
    if (!service) throw notFound('Service');
    const [entry] = await WaitlistModel.create(
      [
        {
          appId: req.tenant!.id,
          staffId: body.staffId,
          serviceId: body.serviceId ?? null,
          requestedDate: body.date,
          contactDataEncrypted: encryptJson(body.customer, env.encryptionKey),
        },
      ],
      { session },
    );
    if (!entry) throw new HttpError(500, 'WAITLIST_CREATE_FAILED', 'Could not create the waitlist entry');
    await AuditLogModel.create(
      [
        {
          appId: req.tenant!.id,
          aggregateType: 'WAITLIST',
          aggregateId: entry._id,
          action: 'WAITLIST_CREATED',
          actorType: 'APP',
          newValue: { staffId: body.staffId, serviceId: body.serviceId ?? null, date: body.date },
        },
      ],
      { session },
    );
    return entry._id.toString();
  });
  res.status(201).json({ data: { id, status: 'WAITING' } });
});
