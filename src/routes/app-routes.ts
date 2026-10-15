import { Router } from 'express';
import { z } from 'zod';
import { env } from '../config.js';
import { withMongoTransaction } from '../db.js';
import { encryptJson } from '../lib/crypto.js';
import { HttpError, notFound } from '../lib/errors.js';
import { apiKeyAuth, bookingManagementAuth } from '../middleware/auth.js';
import { serviceView } from '../lib/views.js';
import { AuditLogModel, ServiceModel, StaffModel, WaitlistModel } from '../models.js';
import { getAnyStaffAvailability, getAvailability } from '../services/availability-service.js';
import {
  cancelBooking,
  confirmHold,
  createHold,
  getBooking,
  requestBookingOtp,
  rescheduleBooking,
  verifyBookingOtp,
} from '../services/booking-service.js';

const uuid = z.string().regex(/^[a-f\d]{24}$/i, 'Must be a MongoDB ObjectId');
const isoTimestamp = z.iso.datetime({ offset: true });
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
  const query = z.object({ catalogRetailerId: z.string().trim().min(1).max(200).optional() }).parse(req.query);
  const services = await ServiceModel.find({
    appId: req.tenant!.id,
    active: true,
    ...(query.catalogRetailerId ? { catalogRetailerId: query.catalogRetailerId } : {}),
  })
    .sort({ name: 1 })
    .lean();
  res.json({ data: services.map(serviceView) });
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
  const query = z.object({ staffId: uuid.optional(), serviceId: uuid, date: z.iso.date() }).parse(req.query);
  const data = query.staffId
    ? await getAvailability(req.tenant!, { ...query, staffId: query.staffId })
    : await getAnyStaffAvailability(req.tenant!, query);
  res.json({ data });
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

appRoutes.get('/bookings/:id', async (req, res) => {
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

appRoutes.post('/bookings/:id/cancel', bookingManagementAuth, async (req, res) => {
  const body = z.object({ reason: z.string().trim().max(300).optional() }).parse(req.body);
  res.json({
    data: await cancelBooking(req.tenant!, uuid.parse(req.params.id), req.principal!, body.reason),
  });
});

appRoutes.patch('/bookings/:id/reschedule', bookingManagementAuth, async (req, res) => {
  const body = z.object({ newSlotStartTime: isoTimestamp }).parse(req.body);
  res.json({
    data: await rescheduleBooking(
      req.tenant!,
      uuid.parse(req.params.id),
      req.principal!,
      body.newSlotStartTime,
    ),
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
