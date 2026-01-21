/**
 * Local Filesystem Storage Provider
 *
 * Stores files on the local filesystem with optional metadata.
 * Files are served via an API endpoint: /api/chat/images/{key}
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import {
  StorageProvider,
  StorageMetadata,
  SaveResult,
} from './StorageProvider';

export class LocalStorageProvider implements StorageProvider {
  private basePath: string;
  private urlPrefix: string;

  /**
   * Create a new LocalStorageProvider
   * @param basePath - Base directory for storing files (default: ./uploads/chat-images)
   * @param urlPrefix - URL prefix for serving files (default: /api/chat/images)
   */
  constructor(
    basePath: string = './uploads/chat-images',
    urlPrefix: string = '/api/chat/images'
  ) {
    this.basePath = path.resolve(basePath);
    this.urlPrefix = urlPrefix;
  }

  /**
   * Get the full filesystem path for a key
   */
  private getFilePath(key: string): string {
    // Sanitize key to prevent directory traversal
    const sanitized = key.replace(/\.\./g, '').replace(/^\/+/, '');
    return path.join(this.basePath, sanitized);
  }

  /**
   * Get the metadata file path for a key
   */
  private getMetadataPath(key: string): string {
    return `${this.getFilePath(key)}.meta.json`;
  }

  async save(
    key: string,
    data: Buffer,
    metadata?: StorageMetadata
  ): Promise<SaveResult> {
    const filePath = this.getFilePath(key);
    const dir = path.dirname(filePath);

    // Ensure directory exists
    await fs.mkdir(dir, { recursive: true });

    // Write file
    await fs.writeFile(filePath, data);

    // Write metadata if provided
    if (metadata) {
      const metaWithTimestamp: StorageMetadata = {
        ...metadata,
        uploadedAt: new Date().toISOString(),
      };
      await fs.writeFile(
        this.getMetadataPath(key),
        JSON.stringify(metaWithTimestamp, null, 2)
      );
    }

    return {
      url: this.getUrl(key),
      key,
      size: data.length,
    };
  }

  async get(key: string): Promise<Buffer | null> {
    const filePath = this.getFilePath(key);

    try {
      return await fs.readFile(filePath);
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return null;
      }
      throw error;
    }
  }

  async getMetadata(key: string): Promise<StorageMetadata | null> {
    const metaPath = this.getMetadataPath(key);

    try {
      const content = await fs.readFile(metaPath, 'utf-8');
      return JSON.parse(content) as StorageMetadata;
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return null;
      }
      throw error;
    }
  }

  async delete(key: string): Promise<void> {
    const filePath = this.getFilePath(key);
    const metaPath = this.getMetadataPath(key);

    // Delete file
    try {
      await fs.unlink(filePath);
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw error;
      }
    }

    // Delete metadata file
    try {
      await fs.unlink(metaPath);
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw error;
      }
    }
  }

  async deleteByPrefix(prefix: string): Promise<void> {
    const keys = await this.list(prefix);
    await Promise.all(keys.map((key) => this.delete(key)));
  }

  async exists(key: string): Promise<boolean> {
    const filePath = this.getFilePath(key);

    try {
      await fs.access(filePath);
      return true;
    } catch {
      return false;
    }
  }

  getUrl(key: string): string {
    // URL-encode the key parts while preserving slashes
    const encodedKey = key
      .split('/')
      .map((part) => encodeURIComponent(part))
      .join('/');
    return `${this.urlPrefix}/${encodedKey}`;
  }

  async list(prefix: string): Promise<string[]> {
    const prefixPath = this.getFilePath(prefix);
    const results: string[] = [];

    try {
      const entries = await fs.readdir(prefixPath, { withFileTypes: true });

      for (const entry of entries) {
        // Skip metadata files
        if (entry.name.endsWith('.meta.json')) {
          continue;
        }

        const entryKey = prefix ? `${prefix}/${entry.name}` : entry.name;

        if (entry.isDirectory()) {
          // Recursively list subdirectories
          const subKeys = await this.list(entryKey);
          results.push(...subKeys);
        } else {
          results.push(entryKey);
        }
      }
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw error;
      }
      // Directory doesn't exist, return empty array
    }

    return results;
  }

  /**
   * Get the base path for this provider
   * Useful for serving files directly via static file serving
   */
  getBasePath(): string {
    return this.basePath;
  }
}
