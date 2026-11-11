export interface Config {
  port: number;
  databaseUrl: string;
  /** Read-only connection to the iam database; see customers.ts. */
  iamDatabaseUrl: string;
  rabbitUrl: string | undefined;
  /** Shared with the gateway, which adds it as `x-internal-key`. No key means every request is refused. */
  internalKey: string | undefined;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  return {
    port: Number(env.PORT ?? 3006),
    databaseUrl: env.DATABASE_URL ?? 'postgres://invoices:invoices@localhost:5432/invoices',
    iamDatabaseUrl: env.IAM_DATABASE_URL ?? 'postgres://invoices_reader:invoices_reader@localhost:5432/iam',
    rabbitUrl: env.RABBITMQ_URL,
    internalKey: env.INVOICES_INTERNAL_KEY ?? (env.NODE_ENV === 'production' ? undefined : 'dev-internal-key'),
  };
}
