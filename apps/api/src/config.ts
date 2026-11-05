import { z } from 'zod';

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().default(4000),
  PUBLIC_URL: z.string().default('http://localhost:4000'),       // externally reachable base for provider webhooks
  WEB_URL: z.string().default('http://localhost:3000'),
  DATABASE_URL: z.string().default('postgres://cloudconnect:cloudconnect@localhost:5432/cloudconnect'),
  DATABASE_POOL_MAX: z.coerce.number().default(20),
  REDIS_URL: z.string().optional(),
  ELASTICSEARCH_URL: z.string().optional(),
  JWT_SECRET: z.string().min(32).default('dev-only-secret-change-me-0123456789abcdef'),
  ENCRYPTION_KEY: z.string().regex(/^[0-9a-f]{64}$/i).default('0'.repeat(64)), // 32-byte hex, AES-256-GCM (use KMS data key in prod)
  ACCESS_TOKEN_TTL_SECONDS: z.coerce.number().default(900),
  REFRESH_TOKEN_TTL_DAYS: z.coerce.number().default(30),
  TELEPHONY_PROVIDER: z.enum(['mock', 'twilio', 'telnyx', 'signalwire', 'plivo', 'vonage']).default('mock'),
  TELEPHONY_VERIFY_SIGNATURES: z.enum(['true', 'false']).default('true').transform((v) => v === 'true'),
  TWILIO_ACCOUNT_SID: z.string().optional(),
  TWILIO_AUTH_TOKEN: z.string().optional(),
  TWILIO_API_KEY: z.string().optional(),
  TWILIO_API_SECRET: z.string().optional(),
  TWILIO_TWIML_APP_SID: z.string().optional(),
  TELNYX_API_KEY: z.string().optional(),
  TELNYX_PUBLIC_KEY: z.string().optional(),
  TELNYX_TEXML_APP_ID: z.string().optional(),
  SIGNALWIRE_PROJECT_ID: z.string().optional(),
  SIGNALWIRE_TOKEN: z.string().optional(),
  SIGNALWIRE_SPACE: z.string().optional(),
  OPENAI_API_KEY: z.string().optional(),
  OPENAI_MODEL: z.string().default('gpt-4o-mini'),
  STRIPE_SECRET_KEY: z.string().optional(),
  STRIPE_WEBHOOK_SECRET: z.string().optional(),
  STRIPE_PRICE_IDS: z.string().default('{}'),                     // JSON {"pro_month":"price_...", ...}
  LIVEKIT_URL: z.string().default('ws://localhost:7880'),
  LIVEKIT_API_KEY: z.string().default('devkey'),
  LIVEKIT_API_SECRET: z.string().default('devsecret-devsecret-devsecret-00'),
  S3_BUCKET: z.string().default('cloudconnect-media-dev'),
  AWS_REGION: z.string().default('us-east-1'),
  GOOGLE_CLIENT_ID: z.string().optional(),
  GOOGLE_CLIENT_SECRET: z.string().optional(),
  MICROSOFT_CLIENT_ID: z.string().optional(),
  MICROSOFT_CLIENT_SECRET: z.string().optional(),
  APPLE_CLIENT_ID: z.string().optional(),
  APPLE_CLIENT_SECRET: z.string().optional(),
  SENTRY_DSN: z.string().optional(),
  CORS_ORIGINS: z.string().default('http://localhost:3000'),
  FRAUD_MAX_CALLS_PER_10MIN: z.coerce.number().default(60),
});

export type AppConfig = z.infer<typeof schema>;

let cached: AppConfig | undefined;
export function config(): AppConfig {
  if (!cached) {
    cached = schema.parse(process.env);
    if (cached.NODE_ENV === 'production') {
      if (cached.JWT_SECRET.startsWith('dev-only')) throw new Error('JWT_SECRET must be set in production');
      if (/^0+$/.test(cached.ENCRYPTION_KEY)) throw new Error('ENCRYPTION_KEY must be set in production');
    }
  }
  return cached;
}
export function resetConfig() { cached = undefined; }
