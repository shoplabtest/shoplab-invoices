import amqp from 'amqplib';
import { EXCHANGE, type OrderPlaced } from './events.ts';
import { issueForOrder, type Deps } from './invoices.ts';

export const QUEUE = 'invoices.events';

/** Routes one message to its handler. Throws on malformed JSON so the caller can reject it. */
export async function handleMessage(deps: Deps, routingKey: string, raw: string): Promise<void> {
  const body = JSON.parse(raw) as unknown;
  if (routingKey === 'order.placed') await issueForOrder(deps, body as OrderPlaced);
}

export async function startConsumer(url: string, deps: Deps) {
  const conn = await amqp.connect(url);
  const ch = await conn.createChannel();
  await ch.assertExchange(EXCHANGE, 'topic', { durable: true });
  await ch.assertQueue(QUEUE, { durable: true });
  await ch.bindQueue(QUEUE, EXCHANGE, 'order.placed');
  await ch.consume(QUEUE, async (msg) => {
    if (!msg) return;
    try {
      await handleMessage(deps, msg.fields.routingKey, msg.content.toString());
      ch.ack(msg);
    } catch (e) {
      console.error(`invoices: rejected ${msg.fields.routingKey}: ${(e as Error).message}`);
      ch.nack(msg, false, false);
    }
  });
  return async () => { await ch.close(); await conn.close(); };
}
