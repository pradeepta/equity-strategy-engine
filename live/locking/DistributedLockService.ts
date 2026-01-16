/**
 * Distributed Lock Service
 * Uses PostgreSQL advisory locks for distributed locking across multiple processes
 */

import { Pool, PoolClient } from 'pg';

/**
 * Service for distributed locking using PostgreSQL advisory locks
 *
 * PostgreSQL advisory locks are:
 * - Session-based (automatically released when connection closes)
 * - Fast (in-memory, no table writes)
 * - Distributed (work across multiple processes/servers)
 * - Fair (FIFO queue for lock waiters)
 */
export class DistributedLockService {
  private heldLocks: Map<string, PoolClient> = new Map();

  constructor(private pool: Pool) {}

  /**
   * Acquire a lock for the given key
   * Returns true if lock acquired, false if timeout
   *
   * @param key - Lock key (e.g., "symbol:AAPL", "strategy:123")
   * @param timeoutMs - Max time to wait for lock (0 = try immediately and return)
   */
  async acquireLock(key: string, timeoutMs: number = 30000): Promise<boolean> {
    if (this.heldLocks.has(key)) {
      console.warn(`Lock already held in this process for: ${key}`);
      return false;
    }

    const lockId = this.hashKey(key);
    const client = await this.pool.connect();
    let shouldRelease = true;

    try {
      if (timeoutMs === 0) {
        // Try to acquire lock immediately without waiting
        const result = await client.query('SELECT pg_try_advisory_lock($1) as acquired', [lockId]);
        const acquired = result.rows[0].acquired;

        if (!acquired) {
          return false;
        }

        // Store client for later release (don't release connection yet)
        this.heldLocks.set(key, client);
        shouldRelease = false;
        return true;
      }

      // Set statement timeout for blocking lock acquisition
      await client.query(`SET statement_timeout = ${timeoutMs}`);

      try {
        // Blocking lock - waits until lock available or timeout
        await client.query('SELECT pg_advisory_lock($1)', [lockId]);

        // Lock acquired successfully
        this.heldLocks.set(key, client);
        shouldRelease = false;

        console.log(`✓ Acquired lock: ${key} (lockId: ${lockId})`);
        return true;
      } catch (error: any) {
        // Check if error is due to timeout
        if (error.code === '57014') {
          // Query timeout
          console.warn(`Lock acquisition timeout for: ${key}`);
          return false;
        }
        throw error;
      } finally {
        // Reset statement timeout
        await client.query('SET statement_timeout = 0');
      }
    } catch (error) {
      throw error;
    } finally {
      if (shouldRelease) {
        client.release();
      }
    }
  }

  /**
   * Release a lock for the given key
   */
  async releaseLock(key: string): Promise<void> {
    const client = this.heldLocks.get(key);
    if (!client) {
      console.warn(`No held lock found for: ${key}`);
      return;
    }

    try {
      const lockId = this.hashKey(key);
      await client.query('SELECT pg_advisory_unlock($1)', [lockId]);
      console.log(`✓ Released lock: ${key} (lockId: ${lockId})`);
    } finally {
      this.heldLocks.delete(key);
      client.release();
    }
  }

  /**
   * Execute a function with a lock
   * Automatically releases lock when done (or on error)
   *
   * @param key - Lock key
   * @param fn - Function to execute while holding lock
   * @param timeoutMs - Max time to wait for lock acquisition
   */
  async withLock<T>(
    key: string,
    fn: () => Promise<T>,
    timeoutMs: number = 30000
  ): Promise<T> {
    const lockId = this.hashKey(key);
    const client = await this.pool.connect();

    try {
      // Acquire lock
      if (timeoutMs === 0) {
        const result = await client.query('SELECT pg_try_advisory_lock($1) as acquired', [lockId]);
        const acquired = result.rows[0].acquired;

        if (!acquired) {
          throw new Error(`Failed to acquire lock immediately for: ${key}`);
        }
      } else {
        await client.query(`SET statement_timeout = ${timeoutMs}`);
        try {
          await client.query('SELECT pg_advisory_lock($1)', [lockId]);
        } catch (error: any) {
          if (error.code === '57014') {
            throw new Error(`Lock acquisition timeout for: ${key}`);
          }
          throw error;
        } finally {
          await client.query('SET statement_timeout = 0');
        }
      }

      console.log(`✓ Acquired lock: ${key} (lockId: ${lockId})`);

      // Execute function while holding lock
      try {
        return await fn();
      } finally {
        // Always release lock, even if function throws
        await client.query('SELECT pg_advisory_unlock($1)', [lockId]);
        console.log(`✓ Released lock: ${key} (lockId: ${lockId})`);
      }
    } finally {
      client.release();
    }
  }

  /**
   * Check if a lock is currently held
   * Note: This is a snapshot check and may change immediately
   */
  async isLocked(key: string): Promise<boolean> {
    const lockId = this.hashKey(key);
    const client = await this.pool.connect();

    try {
      // Try to acquire lock non-blocking
      const result = await client.query('SELECT pg_try_advisory_lock($1) as acquired', [lockId]);
      const acquired = result.rows[0].acquired;

      if (acquired) {
        // We got the lock, so it wasn't held - release it immediately
        await client.query('SELECT pg_advisory_unlock($1)', [lockId]);
        return false;
      }

      // Lock was already held by someone else
      return true;
    } finally {
      client.release();
    }
  }

  /**
   * Release all advisory locks held by current session
   * Useful for cleanup/error recovery
   */
  async releaseAllLocks(): Promise<void> {
    const entries = Array.from(this.heldLocks.entries());
    for (const [key, client] of entries) {
      try {
        const lockId = this.hashKey(key);
        await client.query('SELECT pg_advisory_unlock($1)', [lockId]);
        console.log(`✓ Released lock: ${key} (lockId: ${lockId})`);
      } finally {
        this.heldLocks.delete(key);
        client.release();
      }
    }
  }

  /**
   * Hash a string key to a bigint for PostgreSQL advisory lock
   * Uses a simple hash function for demonstration
   * In production, consider using a more robust hash (e.g., farmhash)
   */
  private hashKey(key: string): number {
    let hash = 0;
    for (let i = 0; i < key.length; i++) {
      const char = key.charCodeAt(i);
      hash = ((hash << 5) - hash) + char;
      hash = hash & hash; // Convert to 32-bit integer
    }

    // Ensure positive integer within PostgreSQL bigint range
    return Math.abs(hash);
  }

  /**
   * Get information about currently held advisory locks
   * Useful for debugging
   */
  async getActiveLocks(): Promise<Array<{ lockId: string; pid: number }>> {
    const client = await this.pool.connect();

    try {
      const result = await client.query(`
        SELECT
          objid as lock_id,
          pid
        FROM pg_locks
        WHERE locktype = 'advisory'
        AND granted = true
      `);

      return result.rows.map(row => ({
        lockId: row.lock_id,
        pid: row.pid,
      }));
    } finally {
      client.release();
    }
  }

  /**
   * Create a symbol-specific lock key
   */
  static symbolLockKey(symbol: string): string {
    return `symbol:${symbol}`;
  }

  /**
   * Create a strategy-specific lock key
   */
  static strategyLockKey(strategyId: string): string {
    return `strategy:${strategyId}`;
  }

  /**
   * Create an operation-specific lock key
   */
  static operationLockKey(operationId: string): string {
    return `operation:${operationId}`;
  }
}
