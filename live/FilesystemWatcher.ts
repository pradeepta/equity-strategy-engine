/**
 * Filesystem Watcher
 * Polls directory for new YAML files (auto-discovery)
 */

import * as fs from 'fs';
import * as path from 'path';

export class FilesystemWatcher {
  private watchDir: string;
  private pollInterval: number;
  private knownFiles: Map<string, number>;  // file path -> last modified time
  private callbacks: Array<(filePath: string) => void>;
  private intervalId?: NodeJS.Timeout;
  private running: boolean = false;

  constructor(watchDir: string, pollInterval: number) {
    this.watchDir = watchDir;
    this.pollInterval = pollInterval;
    this.knownFiles = new Map();
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
    this.scanDirectoryWithTimes().then(files => {
      files.forEach(({ path, mtime }) => this.knownFiles.set(path, mtime));
      console.log(`📁 Found ${files.length} existing strategy files`);
    });

    // Start polling
    this.intervalId = setInterval(() => {
      this.detectChanges();
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
   * Scan directory for YAML files with modification times
   */
  private async scanDirectoryWithTimes(): Promise<Array<{ path: string; mtime: number }>> {
    try {
      // Check if directory exists
      if (!fs.existsSync(this.watchDir)) {
        console.warn(`Directory does not exist: ${this.watchDir}`);
        return [];
      }

      // Read directory
      const entries = await fs.promises.readdir(this.watchDir, { withFileTypes: true });

      // Filter for .yaml files and get stats
      const yamlFiles: Array<{ path: string; mtime: number }> = [];

      for (const entry of entries) {
        if (entry.isFile() && entry.name.endsWith('.yaml')) {
          const filePath = path.join(this.watchDir, entry.name);
          const stats = await fs.promises.stat(filePath);
          yamlFiles.push({
            path: filePath,
            mtime: stats.mtimeMs
          });
        }
      }

      return yamlFiles;
    } catch (error) {
      console.error('Error scanning directory:', error);
      return [];
    }
  }

  /**
   * Detect new or modified files
   */
  private async detectChanges(): Promise<void> {
    try {
      const currentFiles = await this.scanDirectoryWithTimes();
      const changedFiles: string[] = [];

      // Check for new or modified files
      for (const { path: filePath, mtime } of currentFiles) {
        const lastMtime = this.knownFiles.get(filePath);

        if (lastMtime === undefined) {
          // New file
          console.log(`📁 Detected new file: ${path.basename(filePath)}`);
          changedFiles.push(filePath);
          this.knownFiles.set(filePath, mtime);
        } else if (mtime > lastMtime) {
          // Modified file
          console.log(`📝 Detected modified file: ${path.basename(filePath)}`);
          changedFiles.push(filePath);
          this.knownFiles.set(filePath, mtime);
        }
      }

      // Trigger callbacks for changed files
      if (changedFiles.length > 0) {
        for (const file of changedFiles) {
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
      console.error('Error detecting file changes:', error);
    }
  }

  /**
   * Is currently running?
   */
  isRunning(): boolean {
    return this.running;
  }
}
