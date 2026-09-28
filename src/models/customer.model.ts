import { Schema, model } from 'mongoose';

const customerSchema = new Schema(
  {
    appId: { type: Schema.Types.ObjectId, ref: 'App', required: true, index: true },
    dataEncrypted: { type: String, required: true },
    phoneLookupHash: { type: String, default: null },
  },
  { timestamps: true },
);

customerSchema.index({ appId: 1, phoneLookupHash: 1 });

export const CustomerModel = model('Customer', customerSchema);