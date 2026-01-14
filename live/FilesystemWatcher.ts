/**
 * Filesystem Watcher
 * Polls directory for new YAML files (auto-discovery)
 */

import * as fs from 'fs';
import * as path from 'path';

export class FilesystemWatcher {
  private watchDir: string;
  private pollInterval: number;
  private knownFiles: Set<string>;
  private callbacks: Array<(filePath: string) => void>;
  private intervalId?: NodeJS.Timeout;
  private running: boolean = false;

  constructor(watchDir: string, pollInterval: number) {
    this.watchDir = watchDir;
    this.pollInterval = pollInterval;
    this.knownFiles = new Set();
    this.callbacks = [];
  }

  /**
   * Start watching directory
   */
  start(): void {
    if (this.running) {
      return;
    }

    console.log(`📁 Watching directory: ${this.watchDir}`);
    console.log(`📁 Poll interval: ${this.pollInterval}ms`);

    // Initial scan
    this.scanDirectory().then(files => {
      files.forEach(file => this.knownFiles.add(file));
      console.log(`📁 Found ${files.length} existing strategy files`);
    });

    // Start polling
    this.intervalId = setInterval(() => {
      this.detectNewFiles();
    }, this.pollInterval);

    this.running = true;
  }

  /**
   * Stop watching directory
   */
  stop(): void {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = undefined;
    }
    this.running = false;
    console.log('📁 Stopped watching directory');
  }

  /**
   * Register callback for new files
   */
  onNewFile(callback: (filePath: string) => void): void {
    this.callbacks.push(callback);
  }

  /**
   * Scan directory for YAML files
   */
  private async scanDirectory(): Promise<string[]> {
    try {
      // Check if directory exists
      if (!fs.existsSync(this.watchDir)) {
        console.warn(`Directory does not exist: ${this.watchDir}`);
        return [];
      }

      // Read directory
      const entries = await fs.promises.readdir(this.watchDir, { withFileTypes: true });

      // Filter for .yaml files
      const yamlFiles = entries
        .filter(entry => entry.isFile() && entry.name.endsWith('.yaml'))
        .map(entry => path.join(this.watchDir, entry.name));

      return yamlFiles;
    } catch (error) {
      console.error('Error scanning directory:', error);
      return [];
    }
  }

  /**
   * Detect new files (not in knownFiles)
   */
  private async detectNewFiles(): Promise<void> {
    try {
      const currentFiles = await this.scanDirectory();

      // Find new files
      const newFiles = currentFiles.filter(file => !this.knownFiles.has(file));

      if (newFiles.length > 0) {
        console.log(`📁 Detected ${newFiles.length} new strategy file(s)`);

        for (const file of newFiles) {
          // Add to known files
          this.knownFiles.add(file);

          // Trigger callbacks
          for (const callback of this.callbacks) {
            try {
              callback(file);
            } catch (error) {
              console.error(`Error in callback for ${file}:`, error);
            }
          }
        }
      }
    } catch (error) {
      console.error('Error detecting new files:', error);
    }
  }

  /**
   * Is currently running?
   */
  isRunning(): boolean {
    return this.running;
  }
}
