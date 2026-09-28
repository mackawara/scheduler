import { Schema, model } from 'mongoose';

const adminUserSchema = new Schema(
  {
    appId: { type: Schema.Types.ObjectId, ref: 'App', required: true, index: true },
    email: { type: String, required: true, lowercase: true, trim: true },
    passwordHash: { type: String, required: true },
    role: { type: String, enum: ['ADMIN', 'STAFF'], default: 'ADMIN' },
    active: { type: Boolean, default: true },
  },
  { timestamps: true },
);

adminUserSchema.index({ appId: 1, email: 1 }, { unique: true });

export const AdminUserModel = model('AdminUser', adminUserSchema);