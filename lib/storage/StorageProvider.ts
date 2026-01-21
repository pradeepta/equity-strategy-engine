/**
 * Storage Provider Interface
 *
 * Pluggable storage abstraction that allows switching between different storage backends
 * (local filesystem, Google Cloud Storage, AWS S3, etc.) without changing application code.
 *
 * Usage:
 *   const storage = createStorageProvider();
 *   const url = await storage.save('session123/image1.png', buffer, { mimeType: 'image/png' });
 *   const data = await storage.get('session123/image1.png');
 */

/**
 * Metadata that can be associated with stored files
 */
export interface StorageMetadata {
  mimeType?: string;
  originalName?: string;
  uploadedAt?: string;
  [key: string]: string | undefined;
}

/**
 * Configuration for storage providers
 */
export interface StorageConfig {
  /** Storage provider type */
  provider: 'local' | 'gcs' | 's3';

  /** Base path for local storage (default: ./uploads/chat-images) */
  basePath?: string;

  /** Bucket name for cloud storage providers */
  bucket?: string;

  /** Region for cloud storage (S3) */
  region?: string;

  /** Credentials for cloud storage */
  credentials?: {
    /** Path to service account JSON file (GCS) */
    keyFilePath?: string;
    /** Access key ID (S3) */
    accessKeyId?: string;
    /** Secret access key (S3) */
    secretAccessKey?: string;
  };
}

/**
 * Result of a save operation
 */
export interface SaveResult {
  /** URL to access the file */
  url: string;
  /** Storage key used */
  key: string;
  /** Size of the file in bytes */
  size: number;
}

/**
 * Interface for storage providers
 *
 * Implementations must handle:
 * - Saving files with optional metadata
 * - Retrieving file contents
 * - Deleting files
 * - Checking file existence
 * - Generating accessible URLs
 */
export interface StorageProvider {
  /**
   * Save data to storage
   * @param key - Unique identifier/path for the file (e.g., 'sessionId/filename.png')
   * @param data - File contents as Buffer
   * @param metadata - Optional metadata to store with the file
   * @returns Save result including URL and key
   */
  save(key: string, data: Buffer, metadata?: StorageMetadata): Promise<SaveResult>;

  /**
   * Retrieve data from storage
   * @param key - The key used when saving the file
   * @returns File contents as Buffer, or null if not found
   */
  get(key: string): Promise<Buffer | null>;

  /**
   * Retrieve metadata for a file
   * @param key - The key used when saving the file
   * @returns Metadata object, or null if not found
   */
  getMetadata(key: string): Promise<StorageMetadata | null>;

  /**
   * Delete a file from storage
   * @param key - The key used when saving the file
   */
  delete(key: string): Promise<void>;

  /**
   * Delete all files with a given prefix (e.g., all files in a session)
   * @param prefix - The key prefix to match (e.g., 'sessionId/')
   */
  deleteByPrefix(prefix: string): Promise<void>;

  /**
   * Check if a file exists in storage
   * @param key - The key used when saving the file
   * @returns true if the file exists
   */
  exists(key: string): Promise<boolean>;

  /**
   * Get a URL to access the file
   * @param key - The key used when saving the file
   * @returns URL string (may be relative for local storage)
   */
  getUrl(key: string): string;

  /**
   * List all files with a given prefix
   * @param prefix - The key prefix to match
   * @returns Array of keys matching the prefix
   */
  list(prefix: string): Promise<string[]>;
}
