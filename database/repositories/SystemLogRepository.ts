/**
 * System Log Repository
 * Handles audit logging to system_logs table
 */
import { PrismaClient, LogLevel, SystemLog, Prisma } from "@prisma/client";

export class SystemLogRepository {
  constructor(private prisma: PrismaClient) {}

  async create(params: {
    level: LogLevel;
    component: string;
    message: string;
    metadata?: Record<string, unknown>;
  }): Promise<SystemLog> {
    return this.prisma.systemLog.create({
      data: {
        ...params,
        metadata: (params.metadata ?? undefined) as Prisma.InputJsonValue | undefined,
      },
    });
  }
}
