import http from 'node:http';
import { asFaults, fault } from '../tools/lib/fault.ts';
import type { TurnContext } from '../records/job-tools.ts';

type Actions = {
  action_turn_start(context: TurnContext): unknown;
  action_turn_end(releaseId: string): unknown;
  action_collect(source_id: string, channel: string, unit: string): Promise<unknown>;
  action_classify(job: string | null, operation: string): Promise<unknown>;
  action_begin(job: string, step: string, source_id: string, operation: string,
    owner: { pid: number; generation: string }): Promise<unknown>;
  action_bound(unit: string, operation: string, about_job: string, about_move: string,
    source_id: string, owner: { pid: number; generation: string }): Promise<unknown>;
  action_finish(job: string, step: string, source_id: string, action_id: string): Promise<unknown>;
  action_reconcile_ready(job: string, step: string, action_id: string): Promise<unknown>;
  action_reconcile_absent(job: string, step: string, source_id: string, action_id: string,
    read_receipt: { effect: string; evidence_id: string }): Promise<unknown>;
};
const MAX_BODY = 16384;

// This is a service-to-service route. It is not in MCP tools/list. The model's
// shell has no network grant; the runtime and mapped tools call it outside that
// sandbox, then the records service performs the owner-role transaction.
export async function serveActionHttp(actions: Actions, port = 8733) {
  const server = http.createServer(async (request, response) => {
    const send = (status: number, data: unknown) => {
      response.writeHead(status, { 'content-type': 'application/json; charset=utf-8',
        'cache-control': 'no-store' });
      response.end(JSON.stringify(data));
    };
    if (request.method === 'GET' && request.url === '/health') {
      send(200, { schema: 'carbon.records-action-health.v1', status: 'ready' });
      return;
    }
    if (request.method !== 'POST' || !['/collect', '/classify', '/begin', '/bound', '/finish', '/reconcile-ready', '/reconcile-absent',
      '/turn-start', '/turn-end'].includes(request.url ?? '')) {
      send(404, { faults: [fault('RECORDS_ACTION_ROUTE', String(request.url),
        'this route does not exist', 'use an action route from a mapped tool')] });
      return;
    }
    const chunks: Buffer[] = [];
    let length = 0;
    for await (const chunk of request) {
      length += chunk.length;
      if (length > MAX_BODY) {
        send(413, { faults: [fault('RECORDS_ACTION_BODY_LARGE', 'request',
          'action request is over 16 KiB', 'send only the job, step, operation and source ids')] });
        return;
      }
      chunks.push(chunk);
    }
    try {
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      const routes: Record<string, () => unknown> = {
        '/turn-start': () => actions.action_turn_start(body),
        '/turn-end': () => actions.action_turn_end(body.releaseId),
        '/collect': () => actions.action_collect(body.source_id, body.channel, body.unit),
        '/classify': () => actions.action_classify(body.job, body.operation),
        '/begin': () => actions.action_begin(body.job, body.step, body.source_id, body.operation, body.owner),
        '/bound': () => actions.action_bound(body.unit, body.operation, body.about_job, body.about_move,
          body.source_id, body.owner),
        '/finish': () => actions.action_finish(body.job, body.step, body.source_id, body.action_id),
        '/reconcile-ready': () => actions.action_reconcile_ready(body.job, body.step, body.action_id),
        '/reconcile-absent': () => actions.action_reconcile_absent(body.job, body.step, body.source_id,
          body.action_id, body.read_receipt)
      };
      const value = await routes[request.url!]();
      send(200, value);
    } catch (error) {
      send(409, { faults: asFaults(error) });
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => { server.off('error', reject); resolve(); });
  });
  const listening = server.address();
  return { port: typeof listening === 'object' && listening ? listening.port : port,
    close: () => new Promise<void>((resolve, reject) =>
    server.close((error) => error ? reject(error) : resolve())) };
}
