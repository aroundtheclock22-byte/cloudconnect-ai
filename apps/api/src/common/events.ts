import { Injectable } from '@nestjs/common';
import { EventEmitter } from 'events';

export type DomainEvent =
  | 'call.ringing' | 'call.answered' | 'call.completed' | 'call.missed' | 'call.recording.ready' | 'call.analyzed'
  | 'voicemail.received' | 'message.received' | 'message.sent' | 'message.status'
  | 'meeting.started' | 'meeting.ended' | 'meeting.waiting' | 'presence.changed' | 'user.created' | 'number.purchased';

export interface EventEnvelope { id: string; type: DomainEvent; orgId: string; userIds?: string[]; data: Record<string, unknown>; createdAt: string }

/** In-process bus. Multi-instance deployments fan out through Redis pub/sub (see RealtimeGateway). */
@Injectable()
export class EventBus extends EventEmitter {
  publish(type: DomainEvent, orgId: string, data: Record<string, unknown>, userIds?: string[]) {
    const env: EventEnvelope = { id: crypto.randomUUID(), type, orgId, userIds, data, createdAt: new Date().toISOString() };
    this.emit('event', env);
    return env;
  }
}
