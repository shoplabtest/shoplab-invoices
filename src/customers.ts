import type { Pool } from 'pg';

export interface Customer {
  email: string;
  fullName: string;
}

export interface CustomerDirectory {
  find(userId: string): Promise<Customer | null>;
}

/**
 * Looks customers up in iam's own database instead of calling iam. The connection uses a role that can
 * only SELECT `id`, `email` and `full_name` on `users`, so iam must keep those columns as they are.
 */
export class IamDirectory implements CustomerDirectory {
  constructor(private pool: Pool) {}

  async find(userId: string) {
    const r = await this.pool.query<{ email: string; full_name: string }>('SELECT email, full_name FROM users WHERE id = $1', [userId]);
    return r.rows[0] ? { email: r.rows[0].email, fullName: r.rows[0].full_name } : null;
  }
}

export class MemoryDirectory implements CustomerDirectory {
  customers = new Map<string, Customer>();
  async find(userId: string) {
    return this.customers.get(userId) ?? null;
  }
}
