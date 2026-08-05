import type { FastifyInstance } from 'fastify';
import type { AppEvent } from '@ia/shared';
import { events } from '../infra/events';

const HEARTBEAT_MS = 20_000;

/**
 * SSE stream — docs/09 § Events.
 *
 * On reconnect the client sends `Last-Event-ID`; anything still in the ring buffer is
 * replayed. If the requested position has fallen out of the buffer we say so explicitly
 * with a `refetch` event rather than pretending continuity we can't provide.
 *
 * NOTHING LISTENS YET. Every screen refetches instead, so the replay path above has never
 * run against a real client. The stream stays because the events are published anyway and
 * this is the piece that would make a long fill run watchable — but wiring the interface up
 * is more than `new EventSource('/api/events')`. The token hook in app.ts guards every
 * `/api/` URL on a request header, and the browser's EventSource cannot set one; the
 * headers @fastify/cors queues would also be lost, because this handler writes through
 * `reply.raw` and never flushes them. Both need answering before a client can connect.
 */
export async function eventRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/events', async (req, reply) => {
    reply.raw.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });

    const lastId = Number(req.headers['last-event-id'] ?? 0);

    const write = (event: AppEvent) => {
      reply.raw.write(`id: ${event.seq}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
    };

    if (lastId > 0 && events.hasGap(lastId)) {
      reply.raw.write(
        `event: refetch\ndata: ${JSON.stringify({
          reason: 'missed events have aged out of the buffer',
          lastSeq: events.lastSeq,
        })}\n\n`,
      );
    } else if (lastId > 0) {
      for (const e of events.since(lastId)) write(e);
    }

    const onEvent = (e: AppEvent) => write(e);
    events.on('event', onEvent);

    const heartbeat = setInterval(() => reply.raw.write(': keep-alive\n\n'), HEARTBEAT_MS);

    req.raw.on('close', () => {
      clearInterval(heartbeat);
      events.off('event', onEvent);
    });

    // Never resolves — the stream stays open until the client disconnects.
    await new Promise<void>((resolve) => req.raw.on('close', resolve));
  });
}
