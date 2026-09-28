import { Schema, model } from 'mongoose';

const workingHoursSchema = new Schema(
  {
    dayOfWeek: { type: Number, required: true, min: 0, max: 6 },
    startsAt: { type: String, required: true, match: /^([01]\d|2[0-3]):[0-5]\d$/ },
    endsAt: { type: String, required: true, match: /^([01]\d|2[0-3]):[0-5]\d$/ },
  },
  { _id: false },
);

const staffSchema = new Schema(
  {
    appId: { type: Schema.Types.ObjectId, ref: 'App', required: true, index: true },
    name: { type: String, required: true, trim: true },
    resourceType: { type: String, required: true, trim: true },
    workingHours: { type: [workingHoursSchema], default: [] },
    active: { type: Boolean, default: true },
  },
  { timestamps: true },
);

staffSchema.index({ appId: 1, name: 1 }, { unique: true });

export const StaffModel = model('Staff', staffSchema);
export { workingHoursSchema };