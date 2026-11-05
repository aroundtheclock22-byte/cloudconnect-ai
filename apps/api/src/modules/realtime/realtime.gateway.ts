import { Logger, OnModuleInit } from '@nestjs/common';
import { ConnectedSocket, MessageBody, OnGatewayConnection, OnGatewayDisconnect, SubscribeMessage, WebSocketGateway, WebSocketServer } from '@nestjs/websockets';
import Redis from 'ioredis';
import { Server, Socket } from 'socket.io';
import { verifyAccessToken } from '../../common/auth';
import { Db } from '../../common/db.service';
import { EventBus, EventEnvelope } from '../../common/events';
import { config } from '../../config';

/**
 * Realtime channel for presence, incoming-call notifications, messages, typing indicators and
 * read receipts. With REDIS_URL set, events are fanned out across API replicas via pub/sub.
 */
@WebSocketGateway({ path: '/ws', cors: { origin: config().CORS_ORIGINS.split(','), credentials: true } })
export class RealtimeGateway implements OnGatewayConnection, OnGatewayDisconnect, OnModuleInit {
  @WebSocketServer() server: Server;
  private log = new Logger('Realtime');
  private pub?: Redis; private sub?: Redis;
  private readonly instance = crypto.randomUUID();
  constructor(private bus: EventBus, private db: Db) {}

  onModuleInit() {
    if (config().REDIS_URL) {
      this.pub = new Redis(config().REDIS_URL!, { lazyConnect: true, maxRetriesPerRequest: 2 });
      this.sub = new Redis(config().REDIS_URL!, { lazyConnect: true, maxRetriesPerRequest: 2 });
      Promise.all([this.pub.connect(), this.sub.connect()]).then(() => this.sub!.subscribe('cc:events')).catch((e) => this.log.warn(`redis unavailable: ${e.message}`));
      this.sub.on('message', (_c, raw) => { const m = JSON.parse(raw); if (m.from !== this.instance) this.deliver(m.env); });
    }
    this.bus.on('event', (env: EventEnvelope) => {
      this.deliver(env);
      this.pub?.publish('cc:events', JSON.stringify({ from: this.instance, env })).catch(() => undefined);
    });
  }

  private deliver(env: EventEnvelope) {
    if (!this.server) return;
    if (env.userIds?.length) env.userIds.forEach((u) => this.server.to(`user:${u}`).emit(env.type, env));
    else this.server.to(`org:${env.orgId}`).emit(env.type, env);
  }

  async handleConnection(client: Socket) {
    try {
      const token = (client.handshake.auth?.token as string) ?? String(client.handshake.headers.authorization ?? '').replace('Bearer ', '');
      const c = verifyAccessToken(token);
      client.data = { userId: c.sub, orgId: c.org };
      await client.join([`org:${c.org}`, `user:${c.sub}`]);
      await this.db.query(`UPDATE users SET presence = CASE WHEN presence='offline' THEN 'available' ELSE presence END WHERE id=$1`, [c.sub]);
      this.bus.publish('presence.changed', c.org, { userId: c.sub, status: 'available' });
    } catch {
      client.emit('error', 'unauthorized');
      client.disconnect(true);
    }
  }

  async handleDisconnect(client: Socket) {
    const { userId, orgId } = client.data ?? {};
    if (!userId) return;
    const remaining = await this.server.in(`user:${userId}`).fetchSockets();
    if (remaining.length === 0) {
      await this.db.query(`UPDATE users SET presence='offline' WHERE id=$1 AND presence IN ('available','away')`, [userId]);
      this.bus.publish('presence.changed', orgId, { userId, status: 'offline' });
    }
  }

  /** Typing indicator: { conversationId, participants } — relayed to the other participants only. */
  @SubscribeMessage('typing')
  typing(@ConnectedSocket() c: Socket, @MessageBody() b: { conversationId: string; participants: string[]; typing: boolean }) {
    for (const p of (b.participants ?? []).slice(0, 50)) if (p !== c.data.userId) this.server.to(`user:${p}`).emit('typing', { conversationId: b.conversationId, userId: c.data.userId, typing: !!b.typing });
  }

  @SubscribeMessage('read')
  read(@ConnectedSocket() c: Socket, @MessageBody() b: { conversationId: string; participants: string[]; messageId: string }) {
    for (const p of (b.participants ?? []).slice(0, 50)) if (p !== c.data.userId) this.server.to(`user:${p}`).emit('read', { conversationId: b.conversationId, userId: c.data.userId, messageId: b.messageId, at: new Date().toISOString() });
  }
}
