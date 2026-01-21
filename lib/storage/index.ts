/**
 * Storage Provider Factory
 *
 * Creates and configures storage providers based on configuration or environment variables.
 *
 * Environment Variables:
 *   STORAGE_PROVIDER - 'local' | 'gcs' | 's3' (default: 'local')
 *   STORAGE_LOCAL_PATH - Base path for local storage (default: './uploads/chat-images')
 *
 * Future environment variables for cloud providers:
 *   GCS_BUCKET - Google Cloud Storage bucket name
 *   GCS_CREDENTIALS_FILE - Path to service account JSON
 *   AWS_S3_BUCKET - S3 bucket name
 *   AWS_REGION - AWS region
 *   AWS_ACCESS_KEY_ID - AWS access key
 *   AWS_SECRET_ACCESS_KEY - AWS secret key
 */

import { StorageProvider, StorageConfig, StorageMetadata, SaveResult } from './StorageProvider';
import { LocalStorageProvider } from './LocalStorageProvider';

// Re-export types
export type { StorageProvider, StorageConfig, StorageMetadata, SaveResult };
export { LocalStorageProvider };

// Singleton instance for default provider
let defaultProvider: StorageProvider | null = null;

/**
 * Create a storage provider based on configuration
 *
 * @param config - Optional configuration (uses environment variables if not provided)
 * @returns A configured storage provider instance
 *
 * @example
 * // Using environment variables
 * const storage = createStorageProvider();
 *
 * @example
 * // Explicit configuration
 * const storage = createStorageProvider({
 *   provider: 'local',
 *   basePath: './my-uploads'
 * });
 */
export function createStorageProvider(config?: Partial<StorageConfig>): StorageProvider {
  const provider = config?.provider || process.env.STORAGE_PROVIDER || 'local';

  switch (provider) {
    case 'local': {
      const basePath = config?.basePath || process.env.STORAGE_LOCAL_PATH || './uploads/chat-images';
      return new LocalStorageProvider(basePath);
    }

    case 'gcs': {
      // Future implementation
      // const bucket = config?.bucket || process.env.GCS_BUCKET;
      // const keyFilePath = config?.credentials?.keyFilePath || process.env.GCS_CREDENTIALS_FILE;
      // return new GCSStorageProvider({ bucket, keyFilePath });
      throw new Error(
        'Google Cloud Storage provider not yet implemented. ' +
        'Set STORAGE_PROVIDER=local or implement GCSStorageProvider.'
      );
    }

    case 's3': {
      // Future implementation
      // const bucket = config?.bucket || process.env.AWS_S3_BUCKET;
      // const region = config?.region || process.env.AWS_REGION;
      // const accessKeyId = config?.credentials?.accessKeyId || process.env.AWS_ACCESS_KEY_ID;
      // const secretAccessKey = config?.credentials?.secretAccessKey || process.env.AWS_SECRET_ACCESS_KEY;
      // return new S3StorageProvider({ bucket, region, accessKeyId, secretAccessKey });
      throw new Error(
        'AWS S3 storage provider not yet implemented. ' +
        'Set STORAGE_PROVIDER=local or implement S3StorageProvider.'
      );
    }

    default:
      throw new Error(`Unknown storage provider: ${provider}. Use 'local', 'gcs', or 's3'.`);
  }
}

/**
 * Get the default storage provider instance (singleton)
 *
 * Uses environment variables for configuration.
 * Creates the instance on first call and reuses it for subsequent calls.
 *
 * @returns The default storage provider instance
 */
export function getStorageProvider(): StorageProvider {
  if (!defaultProvider) {
    defaultProvider = createStorageProvider();
  }
  return defaultProvider;
}

/**
 * Reset the default storage provider instance
 *
 * Useful for testing or when configuration changes
 */
export function resetStorageProvider(): void {
  defaultProvider = null;
}

/**
 * Helper function to generate a unique storage key for chat images
 *
 * @param sessionId - The chat session ID
 * @param messageId - The message ID
 * @param index - Index of the image in the message (for multiple images)
 * @param mimeType - MIME type of the image (used to determine extension)
 * @returns A unique storage key
 *
 * @example
 * const key = generateImageKey('session123', 'msg456', 0, 'image/png');
 * // Returns: 'session123/msg456-0.png'
 */
export function generateImageKey(
  sessionId: string,
  messageId: string,
  index: number,
  mimeType: string
): string {
  // Extract extension from MIME type
  const extMap: Record<string, string> = {
    'image/png': 'png',
    'image/jpeg': 'jpg',
    'image/jpg': 'jpg',
    'image/gif': 'gif',
    'image/webp': 'webp',
    'image/svg+xml': 'svg',
  };

  const ext = extMap[mimeType] || mimeType.split('/')[1] || 'bin';
  return `${sessionId}/${messageId}-${index}.${ext}`;
}
