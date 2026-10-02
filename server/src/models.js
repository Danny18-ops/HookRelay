import mongoose from 'mongoose';
import { config } from './config.js';

const { Schema } = mongoose;
const ttlDate = () => new Date(Date.now() + config.retentionDays * 86400_000);

const accountSchema = new Schema({
  name: { type: String, required: true },
  apiKeyHash: { type: String, required: true, unique: true },
  apiKeyPrefix: String,
}, { timestamps: true });

const endpointSchema = new Schema({
  accountId: { type: Schema.Types.ObjectId, ref: 'Account', required: true, index: true },
  name: { type: String, required: true },
  token: { type: String, required: true, unique: true },
  provider: { type: String, enum: ['none', 'github', 'stripe', 'shopify', 'generic'], default: 'none' },
  secretEnc: String,
  rateLimitPerMinute: { type: Number, default: config.defaultIngestRateLimitPerMinute },
  active: { type: Boolean, default: true },
}, { timestamps: true });

const ruleSchema = new Schema({
  accountId: { type: Schema.Types.ObjectId, required: true, index: true },
  endpointId: { type: Schema.Types.ObjectId, ref: 'Endpoint', required: true, index: true },
  name: { type: String, required: true },
  enabled: { type: Boolean, default: true },
  filter: {
    match: { type: String, enum: ['all', 'any'], default: 'all' },
    conditions: [{ _id: false, path: String, op: String, value: Schema.Types.Mixed }],
  },
  transform: { type: Schema.Types.Mixed, default: null },
  action: {
    type: { type: String, enum: ['http', 'slack', 'email'], required: true },
    config: { type: Schema.Types.Mixed, default: {} },
  },
}, { timestamps: true, minimize: false });

const eventSchema = new Schema({
  accountId: { type: Schema.Types.ObjectId, required: true },
  endpointId: { type: Schema.Types.ObjectId, required: true },
  status: { type: String, enum: ['accepted', 'rejected'], default: 'accepted' },
  rejectReason: String,
  method: String,
  headers: { type: Schema.Types.Mixed, default: {} },
  contentType: String,
  rawBody: String,
  body: Schema.Types.Mixed,
  signatureValid: { type: Boolean, default: null },
  // `${endpointId}:${key}`; omitted for rejected events so they can never block a valid retry.
  dedupeKey: String,
  deliveryCount: { type: Number, default: 0 },
  receivedAt: { type: Date, default: Date.now },
  expiresAt: { type: Date, default: ttlDate },
}, { minimize: false });
eventSchema.index({ accountId: 1, receivedAt: -1 });
eventSchema.index({ endpointId: 1, receivedAt: -1 });
eventSchema.index({ dedupeKey: 1 }, { unique: true, sparse: true });
if (config.ttlIndexes) eventSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

const attemptSchema = new Schema({
  n: Number,
  startedAt: Date,
  durationMs: Number,
  statusCode: Number,
  error: String,
  responseSnippet: String,
}, { _id: false });

const deliverySchema = new Schema({
  accountId: { type: Schema.Types.ObjectId, required: true },
  endpointId: { type: Schema.Types.ObjectId, required: true },
  eventId: { type: Schema.Types.ObjectId, required: true, index: true },
  ruleId: { type: Schema.Types.ObjectId, required: true },
  ruleName: String,
  actionType: String,
  status: { type: String, enum: ['pending', 'retrying', 'success', 'failed'], default: 'pending' },
  attempts: [attemptSchema],
  attemptCount: { type: Number, default: 0 },
  nextRetryAt: Date,
  lastError: String,
  output: Schema.Types.Mixed,
  replayOf: Schema.Types.ObjectId,
  createdAt: { type: Date, default: Date.now },
  completedAt: Date,
  expiresAt: { type: Date, default: ttlDate },
}, { minimize: false });
deliverySchema.index({ accountId: 1, createdAt: -1 });
deliverySchema.index({ status: 1, createdAt: 1 });
if (config.ttlIndexes) deliverySchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export const Account = mongoose.model('Account', accountSchema);
export const Endpoint = mongoose.model('Endpoint', endpointSchema);
export const Rule = mongoose.model('Rule', ruleSchema);
export const Event = mongoose.model('Event', eventSchema);
export const Delivery = mongoose.model('Delivery', deliverySchema);

export async function connectDb(url = config.mongoUrl) {
  await mongoose.connect(url);
  await Promise.all([Account, Endpoint, Rule, Event, Delivery].map((m) => m.init()));
}
export const disconnectDb = () => mongoose.disconnect();
