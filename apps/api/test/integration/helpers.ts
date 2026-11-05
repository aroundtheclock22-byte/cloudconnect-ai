import { INestApplication } from '@nestjs/common';
import { Client } from 'pg';
import request from 'supertest';

export const TEST_DB = process.env.TEST_DATABASE_URL ?? 'postgres://cloudconnect:cloudconnect@localhost:5432/cloudconnect_test';

export async function bootstrap(): Promise<{ app: INestApplication; http: any }> {
  process.env.NODE_ENV = 'test';
  process.env.DATABASE_URL = TEST_DB;
  process.env.TELEPHONY_PROVIDER = 'mock';
  process.env.RATE_LIMIT_PER_MINUTE = '100000';
  process.env.AUTH_RATE_LIMIT = '100000';
  const c = new Client({ connectionString: TEST_DB });
  await c.connect();
  await c.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await c.query('DROP TYPE IF EXISTS member_role CASCADE');
  await c.end();
  const { migrate } = await import('../../scripts/migrate');
  await migrate(TEST_DB, () => undefined);
  const { createApp } = await import('../../src/bootstrap');
  const app = await createApp();
  await app.init();
  return { app, http: app.getHttpServer() };
}

let n = 0;
export async function signup(http: any, extra: Partial<{ orgName: string; email: string }> = {}) {
  n++;
  const email = extra.email ?? `owner${n}-${Date.now()}@example.com`;
  const res = await request(http).post('/v1/auth/signup').send({ orgName: extra.orgName ?? `Org ${n}`, email, password: 'Sup3rSecret!x', firstName: 'Owner', lastName: String(n), timezone: 'America/New_York' }).expect(201);
  return { token: res.body.accessToken as string, refresh: res.body.refreshToken as string, user: res.body.user, email };
}
export const auth = (t: string) => ({ Authorization: `Bearer ${t}` });
