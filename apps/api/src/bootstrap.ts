import 'reflect-metadata';
import { INestApplication, Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import cookieParser from 'cookie-parser';
import helmet from 'helmet';
import { AppModule } from './app.module';
import { Db } from './common/db.service';
import { config } from './config';
import { graphqlHandler } from './modules/graphql/graphql';
import { httpDuration, httpErrors } from './modules/health/health.controller';

export async function createApp(): Promise<INestApplication> {
  const c = config();
  const app = await NestFactory.create<NestExpressApplication>(AppModule, { rawBody: true, logger: c.NODE_ENV === 'test' ? ['error'] : ['log', 'warn', 'error'] });
  app.set('trust proxy', 1);                         // behind Cloudflare → ALB/NGINX
  app.use(helmet({ contentSecurityPolicy: false }));  // API only; the web app sets its own CSP
  app.use(cookieParser());
  app.useBodyParser('json', { limit: '2mb' });
  app.useBodyParser('urlencoded', { extended: true, limit: '1mb' });
  app.enableCors({ origin: c.CORS_ORIGINS.split(','), credentials: true });
  app.enableShutdownHooks();

  app.use((req: any, res: any, next: () => void) => {
    const end = httpDuration.startTimer();
    res.on('finish', () => {
      const route = req.route?.path ?? 'unmatched';
      end({ method: req.method, route, status: res.statusCode });
      if (res.statusCode >= 500) httpErrors.inc({ route });
    });
    next();
  });

  app.use('/graphql', graphqlHandler(app.get(Db)));

  const doc = SwaggerModule.createDocument(app, new DocumentBuilder()
    .setTitle('CloudConnect AI API').setVersion('1.0').setDescription('REST API for voice, SMS, meetings, contacts, numbers, analytics and administration.')
    .addBearerAuth().build());
  SwaggerModule.setup('docs', app, doc, { jsonDocumentUrl: 'openapi.json' });
  return app;
}

export async function main() {
  const app = await createApp();
  await app.listen(config().PORT);
  new Logger('Bootstrap').log(`API listening on :${config().PORT} (telephony=${config().TELEPHONY_PROVIDER})`);
}
