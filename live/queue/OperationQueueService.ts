/**
 * Operation Queue Service
 * Provides queuing, retry logic, and idempotency for strategy operations
 */

import { PrismaClient, OperationType, OperationStatus } from "@prisma/client";
import { randomUUID } from "crypto";

export interface OperationRequest {
  operationType: OperationType;
  targetSymbol?: string;
  strategyId?: string;
  priority?: number;
  maxRetries?: number;
  payload: Record<string, unknown>;
  operationId?: string; // Optional - for idempotency
}

export interface Operation {
  id: string;
  operationId: string;
  operationType: OperationType;
  targetSymbol?: string | null;
  strategyId?: string | null;
  status: OperationStatus;
  priority: number;
  retryCount: number;
  maxRetries: number;
  payload: Record<string, unknown>;
  result?: Record<string, unknown> | null;
  errorMessage?: string | null;
  createdAt: Date;
  startedAt?: Date | null;
  completedAt?: Date | null;
}

/**
 * Service for managing operation queue with idempotency and retry logic
 */
export class OperationQueueService {
  private processId: string;

  constructor(private prisma: PrismaClient) {
    // Generate unique process ID for locking
    this.processId = `${process.pid}_${Date.now()}`;
  }

  /**
   * Enqueue an operation with idempotency
   * Returns the operation ID (can be used to check status/results later)
   */
  async enqueue(request: OperationRequest): Promise<string> {
    const operationId = request.operationId || randomUUID();

    // Check if operation already exists (idempotency check)
    const existing = await this.prisma.operationQueue.findUnique({
      where: { operationId },
    });

    if (existing) {
      console.log(
        `Operation ${operationId} already exists with status: ${existing.status}`
      );

      // If already completed, return the operation ID (caller can fetch result)
      if (existing.status === "COMPLETED") {
        return existing.operationId;
      }

      // If failed but has retries left, mark as pending again
      if (
        existing.status === "FAILED" &&
        existing.retryCount < existing.maxRetries
      ) {
        await this.prisma.operationQueue.update({
          where: { id: existing.id },
          data: {
            status: "PENDING",
            lockedBy: null,
            lockedUntil: null,
          },
        });
        console.log(`Re-queued failed operation ${operationId} for retry`);
        return existing.operationId;
      }

      // Otherwise, return existing operation ID
      return existing.operationId;
    }

    // Create new operation
    const operation = await this.prisma.operationQueue.create({
      data: {
        operationId,
        operationType: request.operationType,
        targetSymbol: request.targetSymbol,
        strategyId: request.strategyId,
        status: "PENDING",
        priority: request.priority || 0,
        maxRetries: request.maxRetries || 3,
        retryCount: 0,
        payload: request.payload as any,
      },
    });

    console.log(
      `Enqueued operation ${operationId} (type: ${request.operationType})`
    );
    return operation.operationId;
  }

  /**
   * Dequeue the next pending operation for this process
   * Uses optimistic locking to prevent concurrent processing
   */
  async dequeue(): Promise<Operation | null> {
    const now = new Date();
    const lockDuration = 5 * 60 * 1000; // 5 minutes
    const lockExpiry = new Date(now.getTime() + lockDuration);

    // Find highest priority pending operation or expired locked operation
    const operation = await this.prisma.operationQueue.findFirst({
      where: {
        OR: [
          { status: "PENDING" },
          {
            status: "IN_PROGRESS",
            lockedUntil: { lt: now }, // Lock expired
          },
        ],
      },
      orderBy: [{ priority: "desc" }, { createdAt: "asc" }],
    });

    if (!operation) {
      return null;
    }

    // Try to acquire lock with optimistic concurrency control
    try {
      const updated = await this.prisma.operationQueue.updateMany({
        where: {
          id: operation.id,
          // Only update if still in expected state (prevents race conditions)
          OR: [
            { status: "PENDING" },
            {
              status: "IN_PROGRESS",
              lockedUntil: { lt: now },
            },
          ],
        },
        data: {
          status: "IN_PROGRESS",
          lockedBy: this.processId,
          lockedUntil: lockExpiry,
          startedAt: operation.startedAt || now,
        },
      });

      if (updated.count === 0) {
        // Someone else grabbed it first
        return null;
      }

      // Fetch the updated operation
      const lockedOperation = await this.prisma.operationQueue.findUnique({
        where: { id: operation.id },
      });

      if (!lockedOperation) {
        return null;
      }

      console.log(
        `Dequeued operation ${lockedOperation.operationId} (type: ${lockedOperation.operationType})`
      );

      return {
        id: lockedOperation.id,
        operationId: lockedOperation.operationId,
        operationType: lockedOperation.operationType as OperationType,
        targetSymbol: lockedOperation.targetSymbol,
        strategyId: lockedOperation.strategyId,
        status: lockedOperation.status as OperationStatus,
        priority: lockedOperation.priority,
        retryCount: lockedOperation.retryCount,
        maxRetries: lockedOperation.maxRetries,
        payload: lockedOperation.payload as Record<string, unknown>,
        result: lockedOperation.result as Record<string, unknown> | null,
        errorMessage: lockedOperation.errorMessage,
        createdAt: lockedOperation.createdAt,
        startedAt: lockedOperation.startedAt,
        completedAt: lockedOperation.completedAt,
      };
    } catch (error) {
      console.error("Failed to acquire lock on operation:", error);
      return null;
    }
  }

  /**
   * Mark operation as completed with result
   */
  async complete(
    operationId: string,
    result: Record<string, unknown>
  ): Promise<void> {
    await this.prisma.operationQueue.update({
      where: { operationId },
      data: {
        status: "COMPLETED",
        result: result as any,
        completedAt: new Date(),
        lockedBy: null,
        lockedUntil: null,
      },
    });

    console.log(`Completed operation ${operationId}`);
  }

  /**
   * Mark operation as failed
   * If retries available, will be re-queued automatically on next enqueue attempt
   */
  async fail(operationId: string, error: string): Promise<void> {
    const operation = await this.prisma.operationQueue.findUnique({
      where: { operationId },
    });

    if (!operation) {
      throw new Error(`Operation ${operationId} not found`);
    }

    const newRetryCount = operation.retryCount + 1;
    const shouldRetry = newRetryCount < operation.maxRetries;

    await this.prisma.operationQueue.update({
      where: { operationId },
      data: {
        status: shouldRetry ? "PENDING" : "FAILED",
        retryCount: newRetryCount,
        errorMessage: error,
        lockedBy: null,
        lockedUntil: null,
        completedAt: shouldRetry ? null : new Date(),
      },
    });

    if (shouldRetry) {
      console.log(
        `Failed operation ${operationId}, will retry (attempt ${newRetryCount}/${operation.maxRetries})`
      );
    } else {
      console.error(
        `Operation ${operationId} failed permanently after ${newRetryCount} attempts: ${error}`
      );
    }
  }

  /**
   * Check if operation is completed
   */
  async isCompleted(operationId: string): Promise<boolean> {
    const operation = await this.prisma.operationQueue.findUnique({
      where: { operationId },
      select: { status: true },
    });

    return operation?.status === "COMPLETED";
  }

  /**
   * Get operation result (for idempotent replay)
   */
  async getResult(
    operationId: string
  ): Promise<Record<string, unknown> | null> {
    const operation = await this.prisma.operationQueue.findUnique({
      where: { operationId },
      select: { result: true, status: true },
    });

    if (!operation || operation.status !== "COMPLETED") {
      return null;
    }

    return operation.result as Record<string, unknown> | null;
  }

  /**
   * Get operation status
   */
  async getStatus(operationId: string): Promise<OperationStatus | null> {
    const operation = await this.prisma.operationQueue.findUnique({
      where: { operationId },
      select: { status: true },
    });

    return operation?.status as OperationStatus | null;
  }

  /**
   * Cancel a pending operation
   */
  async cancel(operationId: string): Promise<void> {
    await this.prisma.operationQueue.update({
      where: { operationId },
      data: {
        status: "CANCELLED",
        completedAt: new Date(),
        lockedBy: null,
        lockedUntil: null,
      },
    });

    console.log(`Cancelled operation ${operationId}`);
  }

  /**
   * Get queue statistics
   */
  async getQueueStats(): Promise<Record<string, number>> {
    const stats = await this.prisma.operationQueue.groupBy({
      by: ["status"],
      _count: true,
    });

    const result: Record<string, number> = {
      total: 0,
      pending: 0,
      in_progress: 0,
      completed: 0,
      failed: 0,
      cancelled: 0,
    };

    for (const stat of stats) {
      const count = stat._count;
      result.total += count;
      result[stat.status.toLowerCase()] = count;
    }

    return result;
  }

  /**
   * Clean up old completed/failed operations (older than retentionDays)
   */
  async cleanup(retentionDays: number = 7): Promise<number> {
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - retentionDays);

    const result = await this.prisma.operationQueue.deleteMany({
      where: {
        status: {
          in: ["COMPLETED", "FAILED", "CANCELLED"],
        },
        completedAt: {
          lt: cutoffDate,
        },
      },
    });

    console.log(
      `Cleaned up ${result.count} old operations (older than ${retentionDays} days)`
    );
    return result.count;
  }

  /**
   * Release stuck locks (for crash recovery)
   * Call this on startup to release locks from crashed processes
   */
  async releaseStuckLocks(): Promise<number> {
    const now = new Date();

    const result = await this.prisma.operationQueue.updateMany({
      where: {
        status: "IN_PROGRESS",
        lockedUntil: { lt: now },
      },
      data: {
        status: "PENDING",
        lockedBy: null,
        lockedUntil: null,
      },
    });

    if (result.count > 0) {
      console.log(`Released ${result.count} stuck locks`);
    }

    return result.count;
  }
}
