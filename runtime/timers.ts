/**
 * Timer management for entry timeout and other time-based triggers
 */

export class TimerManager {
  private timers: Map<string, number> = new Map(); // timerName -> barsRemaining

  /**
   * Start a timer that expires in N bars
   */
  startTimer(name: string, bars: number): void {
    this.timers.set(name, Math.max(0, bars));
  }

  /**
   * Tick down all active timers (call once per bar)
   */
  tick(): void {
    for (const [name, remaining] of this.timers.entries()) {
      if (remaining > 0) {
        this.timers.set(name, remaining - 1);
      }
    }
  }

  /**
   * Check if a timer has expired
   */
  hasExpired(name: string): boolean {
    const remaining = this.timers.get(name);
    return remaining !== undefined && remaining <= 0;
  }

  /**
   * Get remaining bars for a timer
   */
  getRemaining(name: string): number {
    return this.timers.get(name) || 0;
  }

  /**
   * Cancel a timer
   */
  cancel(name: string): void {
    this.timers.delete(name);
  }

  /**
   * Get all timers
   */
  getAllTimers(): Map<string, number> {
    return new Map(this.timers);
  }

  /**
   * Clear all timers
   */
  clearAll(): void {
    this.timers.clear();
  }
}
