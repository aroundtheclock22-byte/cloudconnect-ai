import { Module } from '@nestjs/common';
import { APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { AuthGuard } from './common/auth';
import { AuditInterceptor, AuditService } from './common/audit';
import { Db } from './common/db.service';
import { EventBus } from './common/events';
import { AiService } from './modules/ai/ai.service';
import { AdminController } from './modules/admin/admin.controller';
import { AnalyticsController } from './modules/analytics/analytics.controller';
import { AuthController } from './modules/auth/auth.controller';
import { AuthService } from './modules/auth/auth.service';
import { BillingController } from './modules/billing/billing.controller';
import { CallsController } from './modules/calls/calls.controller';
import { ContactsController } from './modules/contacts/contacts.controller';
import { DirectoryController } from './modules/directory/directory.controller';
import { HealthController } from './modules/health/health.controller';
import { MeetingsController } from './modules/meetings/meetings.controller';
import { MessagingController, SmsWebhookController } from './modules/messaging/messaging.controller';
import { MessagingService } from './modules/messaging/messaging.service';
import { NumbersController } from './modules/numbers/numbers.controller';
import { FraudService } from './modules/platform/fraud.service';
import { WebhookDispatcher } from './modules/platform/webhooks.service';
import { RealtimeGateway } from './modules/realtime/realtime.gateway';
import { CallControlController, TelephonyWebhookController } from './modules/telephony/telephony.controller';
import { TelephonyService } from './modules/telephony/telephony.service';
import { SearchController } from './modules/search/search.controller';
import { SearchService } from './modules/search/search.service';

/**
 * Single deployable "modular monolith". Each controller/service pair is a bounded context that
 * can be split into its own deployment (see docs/ARCHITECTURE.md §Service decomposition).
 */
@Module({
  imports: [ThrottlerModule.forRoot([{ name: 'default', ttl: 60_000, limit: Number(process.env.RATE_LIMIT_PER_MINUTE ?? 600) }])],
  controllers: [
    HealthController, AuthController, DirectoryController, NumbersController, CallControlController, CallsController, TelephonyWebhookController,
    SmsWebhookController, MessagingController, ContactsController, MeetingsController, BillingController, AnalyticsController, AdminController, SearchController,
  ],
  providers: [
    Db, EventBus, AuditService, AuthService, AiService, FraudService, TelephonyService, MessagingService, WebhookDispatcher, RealtimeGateway, SearchService,
    { provide: APP_GUARD, useClass: ThrottlerGuard },
    { provide: APP_GUARD, useClass: AuthGuard },
    { provide: APP_INTERCEPTOR, useClass: AuditInterceptor },
  ],
})
export class AppModule {}
