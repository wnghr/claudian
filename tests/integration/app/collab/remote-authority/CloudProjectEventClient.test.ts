import http, { type ClientRequest, createServer, type RequestOptions } from 'node:http';
import type { Duplex } from 'node:stream';

import { eventTransportClock, waitForSocket } from '@test/helpers/collab/EventTransportClock';
import { WebSocketServer } from 'ws';

import { CollabProjectConnection } from '@/app/collab/reconnect/CollabProjectConnection';
import { CloudProjectEventClient } from '@/app/collab/remote-authority/CloudAuthorityAdapter';
import { CollabError } from '@/core/collab/ClaudianCollabError';

async function eventServer(upgrade: 'stalled' | 'silent') {
  const server = createServer();
  const sockets = new Set<Duplex>();
  const requests: string[] = [];
  const webSockets = new WebSocketServer({ noServer: true });
  server.on('upgrade', (request, socket, head) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
    requests.push(request.url!);
    if (upgrade !== 'stalled') {
      webSockets.handleUpgrade(request, socket, head, () => undefined);
    }
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing server address');
  return {
    requests,
    get socketCount() { return webSockets.clients.size; },
    async ping(): Promise<void> {
      await Promise.all([...webSockets.clients].map(socket => new Promise<void>(resolve => {
        socket.once('pong', () => resolve());
        socket.ping();
      })));
    },
    serverUrl: `http://127.0.0.1:${address.port}`,
    async close() {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>(resolve => webSockets.close(() => resolve()));
      await new Promise<void>(resolve => server.close(() => resolve()));
    },
  };
}

function controlledClient(
  input: ConstructorParameters<typeof CloudProjectEventClient>[0],
  onInvalidation: ConstructorParameters<typeof CloudProjectEventClient>[1],
) {
  let settle: { resolve(value: 'connected'): void; reject(error: unknown): void } | undefined;
  const connection = new CollabProjectConnection({
    onStatusChange: () => undefined,
    reconnect: () => {
      connection.observeEvents('connecting');
      return new Promise<'connected'>((resolve, reject) => {
        settle = { resolve, reject };
        client.start();
      });
    },
  });
  const client = new CloudProjectEventClient({
    ...input,
    onConnectionResult: error => {
      connection.observeEvents(error ?? 'connected');
      if (error) settle?.reject(error);
      else settle?.resolve('connected');
      settle = undefined;
    },
  }, onInvalidation);
  return {
    get status() { return connection.status; },
    start: () => { void connection.reconnect().catch(() => undefined); },
    dispose: async () => {
      client.dispose();
      settle?.reject(new CollabError({ code: 'cancelled' }));
      settle = undefined;
      await connection.close();
    },
  };
}

describe('Cloud event default transport liveness', () => {
  it('retries a stalled Upgrade after its configured deadline without advancing the cursor', async () => {
    const server = await eventServer('stalled');
    const clock = eventTransportClock();
    const requests: Array<{ request: ClientRequest; timeout: number | undefined }> = [];
    const realRequest = http.request;
    const requestSpy = jest.spyOn(http, 'request').mockImplementation((...args: Parameters<typeof http.request>) => {
      const request = realRequest(...args);
      requests.push({ request, timeout: (args[0] as RequestOptions).timeout });
      return request;
    });
    const invalidations: number[] = [];
    const client = controlledClient({
      headers: {},
      afterSequence: 7,
      projectId: 'project-events',
      serverUrl: server.serverUrl,
    }, async invalidation => {
      invalidations.push(invalidation.sequence);
      return invalidation.sequence;
    });
    try {
      client.start();
      await waitForSocket(() => server.requests.length === 1);
      expect(requests[0].timeout).toBe(30_000);
      // Deliver the native HTTP deadline event; keep the actual socket, ws adapter,
      // connection owner and retry scheduling real, without waiting 30 seconds.
      requests[0].request.emit('timeout');
      await waitForSocket(() => client.status === 'offline');
      await clock.advance(1_000);
      await waitForSocket(() => server.requests.length === 2);
      expect(server.requests.slice(0, 2)).toEqual([
        '/v10/projects/project-events/events?afterSequence=7',
        '/v10/projects/project-events/events?afterSequence=7',
      ]);
      expect(invalidations).toEqual([]);
    } finally {
      try {
        await client.dispose();
        await server.close();
      } finally {
        requestSpy.mockRestore();
        clock.restore();
      }
    }
  });

  it('reconnects a silently lost established socket from the applied cursor', async () => {
    const server = await eventServer('silent');
    const clock = eventTransportClock();
    const client = controlledClient({
      headers: {},
      afterSequence: 3,
      projectId: 'project-events',
      serverUrl: server.serverUrl,
    }, async () => 5);
    try {
      client.start();
      await waitForSocket(() => client.status === 'connected');
      await clock.advance(59_999);
      expect(client.status).toBe('connected');
      expect(server.requests).toHaveLength(1);
      await clock.advance(1);
      await waitForSocket(() => client.status === 'offline');
      await clock.advance(1_000);
      await waitForSocket(() => client.status === 'connected' && server.requests.length === 2);
      expect(server.requests.slice(0, 2)).toEqual([
        '/v10/projects/project-events/events?afterSequence=3',
        '/v10/projects/project-events/events?afterSequence=5',
      ]);
    } finally {
      try {
        await client.dispose();
        await server.close();
      } finally {
        clock.restore();
      }
    }
  });

  it('keeps a heartbeat-responsive idle socket connected and stops on disposal', async () => {
    const server = await eventServer('silent');
    const clock = eventTransportClock();
    const client = controlledClient({
      headers: {},
      afterSequence: 3,
      projectId: 'project-events',
      serverUrl: server.serverUrl,
    }, async () => 5);
    try {
      client.start();
      await waitForSocket(() => client.status === 'connected');
      await clock.advance(30_000);
      await server.ping();
      await clock.advance(59_999);
      expect(client.status).toBe('connected');
      expect(server.requests).toHaveLength(1);
      expect(server.socketCount).toBe(1);
      await client.dispose();
      await waitForSocket(() => server.socketCount === 0);
      await clock.advance(61_000);
      expect(server.requests).toHaveLength(1);
      expect(server.socketCount).toBe(0);
    } finally {
      try {
        await client.dispose();
        await server.close();
      } finally {
        clock.restore();
      }
    }
  });
});

it.each([401, 403])('stops on native Cloud Upgrade authorization rejection %s', async status => {
  const server = createServer();
  server.on('upgrade', (_request, socket) => socket.end(`HTTP/1.1 ${status} Denied\r\nContent-Length: 0\r\n\r\n`));
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing address');
  let report!: (error: CollabError | undefined) => void;
  const failure = new Promise<CollabError | undefined>(resolve => { report = resolve; });
  const client = new CloudProjectEventClient({
    afterSequence: 0, headers: {}, projectId: 'project-a',
    serverUrl: `http://127.0.0.1:${address.port}`, onConnectionResult: report,
  }, async event => event.sequence);
  try {
    client.start();
    await expect(failure).resolves.toMatchObject({ code: 'authorization-denied' });
  } finally {
    client.dispose();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});
