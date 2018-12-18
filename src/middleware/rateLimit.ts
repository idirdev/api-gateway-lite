import { Request, Response, NextFunction } from 'express';
import { RateLimitInfo, ServiceConfig } from '../types/index';
import { logger } from '../utils/logger';

/**
 * In-memory sliding window rate limiter.
 *
 * Tracks request counts per client IP per service within configurable time windows.
 * Uses a sliding window approach: each request is timestamped and old entries
 * are pruned on each check.
 */

interface WindowEntry {
  timestamps: number[];
}

/**
 * Rate limiter store: maps `ip:service` -> list of request timestamps.
 */
class RateLimiterStore {
  private store: Map<string, WindowEntry> = new Map();
  private cleanupInterval: ReturnType<typeof setInterval>;

  constructor() {
    // Periodically clean up expired entries every 60 seconds
    this.cleanupInterval = setInterval(() => {
      this.cleanup();
    }, 60_000);

    if (this.cleanupInterval && typeof this.cleanupInterval === 'object' && 'unref' in this.cleanupInterval) {
      this.cleanupInterval.unref();
    }
  }

  /**
   * Check if a request is allowed and record it if so.
   *
   * @param key - Unique identifier (usually ip:service)
   * @param limit - Maximum requests in the window
   * @param windowMs - Window size in milliseconds
   * @returns Rate limit info including remaining count and reset time
   */
  check(key: string, limit: number, windowMs: number): RateLimitInfo {
    const now = Date.now();
    const windowStart = now - windowMs;

    let entry = this.store.get(key);
    if (!entry) {
      entry = { timestamps: [] };
      this.store.set(key, entry);
    }

    // Remove timestamps outside the current window
    entry.timestamps = entry.timestamps.filter((ts) => ts > windowStart);

    const currentCount = entry.timestamps.length;
    const remaining = Math.max(0, limit - currentCount);

    // Calculate when the earliest request in the window will expire
    const resetAt = entry.timestamps.length > 0
      ? entry.timestamps[0] + windowMs
      : now + windowMs;

    if (currentCount >= limit) {
      return { remaining: 0, limit, resetAt };
    }

    // Record this request
    entry.timestamps.push(now);

    return { remaining: remaining - 1, limit, resetAt };
  }

  /**
   * Get current rate limit info without recording a request.
   */
  peek(key: string, limit: number, windowMs: number): RateLimitInfo {
    const now = Date.now();
    const windowStart = now - windowMs;
    const entry = this.store.get(key);

    if (!entry) {
      return { remaining: limit, limit, resetAt: now + windowMs };
    }

    const activeTimestamps = entry.timestamps.filter((ts) => ts > windowStart);
    const remaining = Math.max(0, limit - activeTimestamps.length);
    const resetAt = activeTimestamps.length > 0
      ? activeTimestamps[0] + windowMs
      : now + windowMs;

    return { remaining, limit, resetAt };
  }

  /**
   * Reset rate limit for a specific key.
   */
  reset(key: string): void {
    this.store.delete(key);
  }

  /**
   * Clean up expired entries from all keys.
   */
  private cleanup(): void {
    const now = Date.now();
    const maxAge = 300_000; // 5 minutes

    for (const [key, entry] of this.store) {
      entry.timestamps = entry.timestamps.filter((ts) => now - ts < maxAge);
      if (entry.timestamps.length === 0) {
        this.store.delete(key);
      }
    }
  }

  /**
   * Destroy the store and stop cleanup.
   */
  destroy(): void {
    clearInterval(this.cleanupInterval);
    this.store.clear();
  }
}

/** Singleton rate limiter store. */
const rateLimiterStore = new RateLimiterStore();

/**
 * Create a rate limiting middleware.
 * Uses per-service limits from the service config, or falls back to a global limit.
 *
 * @param globalLimit - Default rate limit if service has none (0 = unlimited)
 * @param globalWindow - Default window in ms (default: 60000)
 */
export function createRateLimiter(globalLimit: number = 0, globalWindow: number = 60_000) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const serviceConfig = (req as any).__gatewayService as ServiceConfig | undefined;

    // Determine the applicable rate limit
    const limit = serviceConfig?.rateLimit || globalLimit;
    const windowMs = serviceConfig?.rateLimitWindow || globalWindow;

    // If no rate limit configured, pass through
    if (limit <= 0) {
      next();
      return;
    }

    // Build a unique key: IP + service name
    const clientIp = req.ip || req.socket.remoteAddress || 'unknown';
    const serviceName = serviceConfig?.name || 'global';
    const key = `${clientIp}:${serviceName}`;

    const info = rateLimiterStore.check(key, limit, windowMs);

    // Set standard rate limit headers
    res.setHeader('X-RateLimit-Limit', info.limit);
    res.setHeader('X-RateLimit-Remaining', info.remaining);
    res.setHeader('X-RateLimit-Reset', Math.ceil(info.resetAt / 1000));

    if (info.remaining < 0 || (info.remaining === 0 && rateLimiterStore.peek(key, limit, windowMs).remaining === 0)) {
      const retryAfter = Math.ceil((info.resetAt - Date.now()) / 1000);

      logger.warn('Rate limit exceeded', {
        ip: clientIp,
        service: serviceName,
        limit,
        retryAfter,
      });

      res.setHeader('Retry-After', Math.max(1, retryAfter));
      res.status(429).json({
        error: 'Too Many Requests',
        message: `Rate limit exceeded. Try again in ${Math.max(1, retryAfter)} seconds.`,
        retryAfter: Math.max(1, retryAfter),
      });
      return;
    }

    next();
  };
}

export { rateLimiterStore };
