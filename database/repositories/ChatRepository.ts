/**
 * Chat Repository
 * Handles all database operations for chat sessions and messages
 */

import { PrismaClient, ChatSession, ChatMessage, ChatRole, Prisma } from '@prisma/client';

export type ChatSessionWithMessages = ChatSession & { messages: ChatMessage[] };

export interface CreateSessionParams {
  userId: string;
  title?: string;
  gatewaySessionId?: string;
  agentSessionId?: string;
  persona?: string;
}

export interface AddMessageParams {
  chatSessionId: string;
  role: ChatRole;
  content: string;
  imageUrls?: string[];
}

export interface FindSessionsOptions {
  limit?: number;
  offset?: number;
  includeDeleted?: boolean;
}

export class ChatRepository {
  constructor(private prisma: PrismaClient) {}

  // ============================================================================
  // Session Operations
  // ============================================================================

  /**
   * Create a new chat session
   */
  async createSession(params: CreateSessionParams): Promise<ChatSession> {
    return this.prisma.chatSession.create({
      data: {
        userId: params.userId,
        title: params.title || 'New Chat',
        gatewaySessionId: params.gatewaySessionId,
        agentSessionId: params.agentSessionId,
        persona: params.persona || 'blackrock_advisor',
      },
    });
  }

  /**
   * Find session by ID
   */
  async findSessionById(id: string): Promise<ChatSession | null> {
    return this.prisma.chatSession.findUnique({
      where: { id },
    });
  }

  /**
   * Find session by gateway session ID
   */
  async findSessionByGatewayId(gatewaySessionId: string): Promise<ChatSession | null> {
    return this.prisma.chatSession.findFirst({
      where: {
        gatewaySessionId,
        deletedAt: null,
      },
    });
  }

  /**
   * Find all sessions for a user
   */
  async findSessionsByUser(
    userId: string,
    options?: FindSessionsOptions
  ): Promise<ChatSession[]> {
    return this.prisma.chatSession.findMany({
      where: {
        userId,
        deletedAt: options?.includeDeleted ? undefined : null,
      },
      orderBy: { lastMessageAt: { sort: 'desc', nulls: 'last' } },
      take: options?.limit || 50,
      skip: options?.offset || 0,
    });
  }

  /**
   * Update session metadata
   */
  async updateSession(
    sessionId: string,
    data: {
      title?: string;
      gatewaySessionId?: string;
      agentSessionId?: string;
      isActive?: boolean;
      messageCount?: number;
      lastMessageAt?: Date;
    }
  ): Promise<ChatSession> {
    return this.prisma.chatSession.update({
      where: { id: sessionId },
      data,
    });
  }

  /**
   * Soft delete a session
   */
  async softDeleteSession(sessionId: string): Promise<void> {
    await this.prisma.chatSession.update({
      where: { id: sessionId },
      data: { deletedAt: new Date() },
    });
  }

  /**
   * Restore a soft-deleted session
   */
  async restoreSession(sessionId: string): Promise<ChatSession> {
    return this.prisma.chatSession.update({
      where: { id: sessionId },
      data: { deletedAt: null },
    });
  }

  /**
   * Count user's sessions
   */
  async countUserSessions(userId: string): Promise<number> {
    return this.prisma.chatSession.count({
      where: { userId, deletedAt: null },
    });
  }

  // ============================================================================
  // Message Operations
  // ============================================================================

  /**
   * Add a message to a session
   */
  async addMessage(params: AddMessageParams): Promise<ChatMessage> {
    return this.prisma.$transaction(async (tx) => {
      // Get current message count for sequence number
      const session = await tx.chatSession.findUnique({
        where: { id: params.chatSessionId },
        select: { messageCount: true },
      });

      if (!session) {
        throw new Error(`Session not found: ${params.chatSessionId}`);
      }

      const sequenceNumber = session.messageCount + 1;

      // Create message
      const message = await tx.chatMessage.create({
        data: {
          chatSessionId: params.chatSessionId,
          role: params.role,
          content: params.content,
          imageUrls: params.imageUrls || [],
          sequenceNumber,
        },
      });

      // Update session metadata
      await tx.chatSession.update({
        where: { id: params.chatSessionId },
        data: {
          messageCount: sequenceNumber,
          lastMessageAt: new Date(),
        },
      });

      return message;
    });
  }

  /**
   * Get messages for a session
   */
  async getMessages(
    chatSessionId: string,
    options?: {
      limit?: number;
      offset?: number;
      order?: 'asc' | 'desc';
    }
  ): Promise<ChatMessage[]> {
    return this.prisma.chatMessage.findMany({
      where: { chatSessionId },
      orderBy: { sequenceNumber: options?.order || 'asc' },
      take: options?.limit,
      skip: options?.offset,
    });
  }

  /**
   * Get session with messages
   */
  async getSessionWithMessages(
    sessionId: string,
    messageLimit?: number
  ): Promise<ChatSessionWithMessages | null> {
    return this.prisma.chatSession.findUnique({
      where: { id: sessionId },
      include: {
        messages: {
          orderBy: { sequenceNumber: 'asc' },
          take: messageLimit,
        },
      },
    });
  }

  /**
   * Update message image URLs (used after image upload)
   */
  async updateMessageImages(
    messageId: string,
    imageUrls: string[]
  ): Promise<ChatMessage> {
    return this.prisma.chatMessage.update({
      where: { id: messageId },
      data: { imageUrls },
    });
  }

  /**
   * Get a single message by ID
   */
  async getMessageById(messageId: string): Promise<ChatMessage | null> {
    return this.prisma.chatMessage.findUnique({
      where: { id: messageId },
    });
  }

  // ============================================================================
  // Search & Utility Operations
  // ============================================================================

  /**
   * Search sessions by title or message content
   */
  async searchSessions(userId: string, query: string): Promise<ChatSession[]> {
    return this.prisma.chatSession.findMany({
      where: {
        userId,
        deletedAt: null,
        OR: [
          { title: { contains: query, mode: 'insensitive' } },
          {
            messages: {
              some: { content: { contains: query, mode: 'insensitive' } },
            },
          },
        ],
      },
      orderBy: { lastMessageAt: { sort: 'desc', nulls: 'last' } },
      take: 20,
    });
  }

  /**
   * Delete all images associated with a session (for cleanup)
   * Returns the image URLs that were associated with the session
   */
  async getSessionImageUrls(sessionId: string): Promise<string[]> {
    const messages = await this.prisma.chatMessage.findMany({
      where: { chatSessionId: sessionId },
      select: { imageUrls: true },
    });

    return messages.flatMap((m) => m.imageUrls);
  }

  /**
   * Hard delete a session (use with caution)
   * Note: Messages are cascade deleted by the database
   */
  async hardDeleteSession(sessionId: string): Promise<void> {
    await this.prisma.chatSession.delete({
      where: { id: sessionId },
    });
  }
}
