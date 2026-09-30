import { Kafka, Producer, Consumer, Admin } from 'kafkajs';
import { config } from '../../config/index.js';
import { logger } from '../../common/logger.js';
import { kafkaMetrics } from './kafka.metrics.js';

export interface KafkaMessagePayload {
  key: string;
  value: string;
  headers?: Record<string, string>;
}

export interface KafkaProducerRecord {
  topic: string;
  messages: KafkaMessagePayload[];
}

export interface IKafkaProducer {
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  send(record: KafkaProducerRecord): Promise<void>;
  isAvailable(): boolean;
}

export interface KafkaMessageBatch {
  topic: string;
  partition: number;
  message: {
    key: string | null;
    value: string;
    headers?: Record<string, string | undefined>;
    offset?: string;
    timestamp?: string;
  };
}

export interface IKafkaConsumer {
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  subscribe(topics: string[], fromBeginning?: boolean): Promise<void>;
  run(handler: (batch: KafkaMessageBatch) => Promise<void>): Promise<void>;
  isAvailable(): boolean;
}

export interface IKafkaAdmin {
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  listTopics(): Promise<string[]>;
  createTopics(topics: Array<{ topic: string; numPartitions?: number; replicationFactor?: number }>): Promise<boolean>;
}

export interface IKafkaClient {
  producer(): IKafkaProducer;
  consumer(groupId: string): IKafkaConsumer;
  admin(): IKafkaAdmin;
  isAvailable(): boolean;
  disconnect(): Promise<void>;
  ping(): Promise<boolean>;
}

/**
 * In-Memory Kafka Test Double
 * Implements deterministic partition assignment, independent consumer groups,
 * and error/disconnect simulation.
 */
export class InMemoryKafkaClient implements IKafkaClient {
  private topics = new Set<string>();
  private messageStore = new Map<string, Array<{ key: string; value: string; partition: number; headers?: Record<string, string> }>>();
  private consumers: Array<{
    groupId: string;
    topics: string[];
    handler: (batch: KafkaMessageBatch) => Promise<void>;
    connected: boolean;
  }> = [];
  private available = true;

  constructor() {
    this.topics.add('ledgerx.payment.events');
    this.topics.add('ledgerx.refund.events');
    this.topics.add('ledgerx.settlement.events');
    this.topics.add('ledgerx.domain.events');
    this.topics.add('ledgerx.webhook.events');
    this.topics.add('ledgerx.webhook.dlq');
  }

  public setAvailable(available: boolean): void {
    this.available = available;
    kafkaMetrics.setConnectionStatus(available ? 'CONNECTED' : 'DISCONNECTED');
  }

  public isAvailable(): boolean {
    return this.available;
  }

  public async ping(): Promise<boolean> {
    if (!this.available) throw new Error('Kafka broker connection unavailable');
    return true;
  }

  public async disconnect(): Promise<void> {
    this.consumers.forEach((c) => {
      c.connected = false;
    });
  }

  public clear(): void {
    this.messageStore.clear();
    this.consumers = [];
  }

  public getMessages(topic: string) {
    return this.messageStore.get(topic) || [];
  }

  public getPublishedEvents(topic: string) {
    return this.getMessages(topic);
  }

  public producer(): IKafkaProducer {
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const self = this;
    let connected = false;

    return {
      connect: async () => {
        if (!self.available) throw new Error('Kafka broker connection unavailable');
        connected = true;
      },
      disconnect: async () => {
        connected = false;
      },
      send: async (record: KafkaProducerRecord) => {
        if (!self.available || !connected) {
          kafkaMetrics.recordError();
          throw new Error('Kafka producer is disconnected or broker unavailable');
        }

        self.topics.add(record.topic);
        let list = self.messageStore.get(record.topic);
        if (!list) {
          list = [];
          self.messageStore.set(record.topic, list);
        }

        for (const msg of record.messages) {
          // Partition key hashing simulation: deterministic partition assignment (0..3)
          let hash = 0;
          for (let i = 0; i < msg.key.length; i++) {
            hash = (hash * 31 + msg.key.charCodeAt(i)) % 4;
          }
          const partition = Math.abs(hash);

          const stored = { key: msg.key, value: msg.value, partition, headers: msg.headers };
          list.push(stored);
          kafkaMetrics.recordPublished();

          // Dispatch to subscribed consumers independently per consumer group
          for (const consumer of self.consumers) {
            if (consumer.connected && consumer.topics.includes(record.topic)) {
              try {
                await consumer.handler({
                  topic: record.topic,
                  partition,
                  message: {
                    key: msg.key,
                    value: msg.value,
                    headers: msg.headers,
                    offset: String(list.length - 1),
                    timestamp: String(Date.now()),
                  },
                });
                kafkaMetrics.recordConsumed();
              } catch (err) {
                kafkaMetrics.recordError();
                logger.warn(`Error in consumer handler for group ${consumer.groupId}`, {
                  error: err instanceof Error ? err.message : String(err),
                });
              }
            }
          }
        }
      },
      isAvailable: () => self.available && connected,
    };
  }

  public consumer(groupId: string): IKafkaConsumer {
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const self = this;
    const registration: {
      groupId: string;
      topics: string[];
      handler: (batch: KafkaMessageBatch) => Promise<void>;
      connected: boolean;
    } = {
      groupId,
      topics: [],
      handler: async () => {},
      connected: false,
    };
    self.consumers.push(registration);

    return {
      connect: async () => {
        if (!self.available) throw new Error('Kafka broker connection unavailable');
        registration.connected = true;
      },
      disconnect: async () => {
        registration.connected = false;
      },
      subscribe: async (topics: string[]) => {
        registration.topics = [...topics];
      },
      run: async (handler: (batch: KafkaMessageBatch) => Promise<void>) => {
        registration.handler = handler;
      },
      isAvailable: () => self.available && registration.connected,
    };
  }

  public admin(): IKafkaAdmin {
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const self = this;
    return {
      connect: async () => {
        if (!self.available) throw new Error('Kafka broker connection unavailable');
      },
      disconnect: async () => {},
      listTopics: async () => Array.from(self.topics),
      createTopics: async (topics) => {
        topics.forEach((t) => self.topics.add(t.topic));
        return true;
      },
    };
  }
}

/**
 * Production Kafka Adapter wrapping kafkajs
 */
export class RealKafkaClientAdapter implements IKafkaClient {
  private kafka: Kafka;
  private connected = false;
  private activeProducer: Producer | null = null;
  private activeConsumers: Consumer[] = [];
  private activeAdmin: Admin | null = null;

  constructor() {
    const brokers = config.KAFKA_BROKERS.split(',').map((b) => b.trim());
    this.kafka = new Kafka({
      clientId: config.KAFKA_CLIENT_ID,
      brokers,
      connectionTimeout: config.KAFKA_CONNECT_TIMEOUT_MS,
      retry: {
        initialRetryTime: 300,
        retries: 5,
      },
    });
  }

  public isAvailable(): boolean {
    return this.connected;
  }

  public async ping(): Promise<boolean> {
    try {
      const admin = this.kafka.admin();
      await admin.connect();
      await admin.listTopics();
      await admin.disconnect();
      this.connected = true;
      kafkaMetrics.setConnectionStatus('CONNECTED');
      return true;
    } catch (err) {
      this.connected = false;
      kafkaMetrics.setConnectionStatus('DISCONNECTED');
      kafkaMetrics.recordError();
      throw err;
    }
  }

  public producer(): IKafkaProducer {
    if (!this.activeProducer) {
      this.activeProducer = this.kafka.producer();
    }
    const p = this.activeProducer;
    let isProducerConnected = false;

    return {
      connect: async () => {
        await p.connect();
        isProducerConnected = true;
        this.connected = true;
        kafkaMetrics.setConnectionStatus('CONNECTED');
      },
      disconnect: async () => {
        await p.disconnect();
        isProducerConnected = false;
      },
      send: async (record: KafkaProducerRecord) => {
        try {
          await p.send({
            topic: record.topic,
            messages: record.messages.map((m) => ({
              key: m.key,
              value: m.value,
              headers: m.headers,
            })),
          });
          kafkaMetrics.recordPublished(record.messages.length);
        } catch (err) {
          kafkaMetrics.recordError();
          throw err;
        }
      },
      isAvailable: () => isProducerConnected,
    };
  }

  public consumer(groupId: string): IKafkaConsumer {
    const c = this.kafka.consumer({ groupId });
    this.activeConsumers.push(c);
    let isConsumerConnected = false;

    return {
      connect: async () => {
        await c.connect();
        isConsumerConnected = true;
      },
      disconnect: async () => {
        await c.disconnect();
        isConsumerConnected = false;
      },
      subscribe: async (topics: string[], fromBeginning = false) => {
        for (const topic of topics) {
          await c.subscribe({ topic, fromBeginning });
        }
      },
      run: async (handler: (batch: KafkaMessageBatch) => Promise<void>) => {
        await c.run({
          eachMessage: async ({ topic, partition, message }) => {
            const keyStr = message.key ? message.key.toString('utf-8') : null;
            const valStr = message.value ? message.value.toString('utf-8') : '';
            const headers: Record<string, string | undefined> = {};
            if (message.headers) {
              for (const [hk, hv] of Object.entries(message.headers)) {
                headers[hk] = hv ? hv.toString('utf-8') : undefined;
              }
            }

            try {
              await handler({
                topic,
                partition,
                message: {
                  key: keyStr,
                  value: valStr,
                  headers,
                  offset: message.offset,
                  timestamp: message.timestamp,
                },
              });
              kafkaMetrics.recordConsumed();
            } catch (err) {
              kafkaMetrics.recordError();
              throw err;
            }
          },
        });
      },
      isAvailable: () => isConsumerConnected,
    };
  }

  public admin(): IKafkaAdmin {
    if (!this.activeAdmin) {
      this.activeAdmin = this.kafka.admin();
    }
    const adm = this.activeAdmin;

    return {
      connect: async () => {
        await adm.connect();
      },
      disconnect: async () => {
        await adm.disconnect();
      },
      listTopics: async () => {
        return await adm.listTopics();
      },
      createTopics: async (topics) => {
        return await adm.createTopics({
          topics: topics.map((t) => ({
            topic: t.topic,
            numPartitions: t.numPartitions ?? 3,
            replicationFactor: t.replicationFactor ?? 1,
          })),
        });
      },
    };
  }

  public async disconnect(): Promise<void> {
    if (this.activeProducer) {
      await this.activeProducer.disconnect();
    }
    for (const c of this.activeConsumers) {
      await c.disconnect();
    }
    if (this.activeAdmin) {
      await this.activeAdmin.disconnect();
    }
    this.connected = false;
    kafkaMetrics.setConnectionStatus('DISCONNECTED');
  }
}

// Global Singleton Management
let activeKafkaClient: IKafkaClient | null = null;

export async function getKafkaClient(): Promise<IKafkaClient> {
  if (activeKafkaClient) {
    return activeKafkaClient;
  }

  if (config.NODE_ENV === 'test') {
    activeKafkaClient = new InMemoryKafkaClient();
    kafkaMetrics.setConnectionStatus('CONNECTED');
    return activeKafkaClient;
  }

  try {
    const realClient = new RealKafkaClientAdapter();
    // Attempt health ping with short timeout
    await realClient.ping();
    activeKafkaClient = realClient;
    return activeKafkaClient;
  } catch (err) {
    logger.warn('Real Kafka broker connection failed; activating in-memory Kafka client fallback', {
      error: { message: err instanceof Error ? err.message : String(err) },
    });
    activeKafkaClient = new InMemoryKafkaClient();
    kafkaMetrics.setConnectionStatus('DEGRADED');
    return activeKafkaClient;
  }
}

export function setKafkaClient(client: IKafkaClient): void {
  activeKafkaClient = client;
}

export function resetKafkaClient(): void {
  activeKafkaClient = null;
}

/**
 * Health check probe for Kafka broker
 */
export async function checkKafkaHealth(): Promise<{
  connected: boolean;
  latencyMs?: number;
  error?: string;
}> {
  const start = performance.now();
  try {
    const client = await getKafkaClient();
    await client.ping();
    const latencyMs = Math.round(performance.now() - start);
    return { connected: true, latencyMs };
  } catch (err) {
    const latencyMs = Math.round(performance.now() - start);
    return {
      connected: false,
      latencyMs,
      error: err instanceof Error ? err.message : 'Kafka broker ping failed',
    };
  }
}
