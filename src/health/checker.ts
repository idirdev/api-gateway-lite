import http from 'http';
import https from 'https';
import { ServiceConfig, HealthStatus } from '../types/index';
import { loadBalancer } from '../middleware/loadBalancer';
import { logger } from '../utils/logger';

/**
 * Health checker that periodically checks the health of all upstream services.
 * Updates the load balancer and circuit breaker states based on results.
 */

class HealthChecker {
  private results: Map<string, HealthStatus> = new Map();
  private intervalHandle: ReturnType<typeof setInterval> | null = null;
  private checkTimeout: number = 5000; // 5 second timeout for health checks

  /**
   * Start periodic health checks for all registered services.
   *
   * @param services - Array of service configurations to monitor
   * @param intervalMs - How often to check (milliseconds)
   */
  start(services: ServiceConfig[], intervalMs: number = 30_000): void {
    // Run an initial check immediately
    this.checkAll(services);

    // Then check periodically
    this.intervalHandle = setInterval(() => {
      this.checkAll(services);
    }, intervalMs);

    if (this.intervalHandle && typeof this.intervalHandle === 'object' && 'unref' in this.intervalHandle) {
      this.intervalHandle.unref();
    }

    logger.info(`Health checker started (interval: ${intervalMs}ms, services: ${services.length})`);
  }

  /**
   * Stop periodic health checks.
   */
  stop(): void {
    if (this.intervalHandle) {
      clearInterval(this.intervalHandle);
      this.intervalHandle = null;
      logger.info('Health checker stopped');
    }
  }

  /**
   * Check health of all services and their upstreams.
   */
  async checkAll(services: ServiceConfig[]): Promise<void> {
    const promises: Promise<void>[] = [];

    for (const service of services) {
      if (!service.enabled) continue;

      for (const upstream of service.upstreams) {
        promises.push(this.checkUpstream(service, upstream));
      }
    }

    await Promise.allSettled(promises);
  }

  /**
   * Check the health of a single upstream.
   */
  async checkUpstream(service: ServiceConfig, upstreamUrl: string): Promise<void> {
    const healthPath = service.healthCheckPath || '/health';
    const fullUrl = `${upstreamUrl}${healthPath}`;
    const key = `${service.name}:${upstreamUrl}`;

    const startTime = Date.now();
    let statusCode = 0;
    let healthy = false;

    try {
      statusCode = await this.httpGet(fullUrl);
      healthy = statusCode >= 200 && statusCode < 300;
    } catch (error) {
      healthy = false;
      logger.debug(`Health check failed for ${key}: ${(error as Error).message}`);
    }

    const responseTime = Date.now() - startTime;

    // Get or create the health status record
    const existing = this.results.get(key);
    const consecutiveFailures = healthy
      ? 0
      : (existing?.consecutiveFailures || 0) + 1;

    const status: HealthStatus = {
      service: service.name,
      url: upstreamUrl,
      healthy,
      lastStatusCode: statusCode,
      lastResponseTime: responseTime,
      lastChecked: new Date(),
      consecutiveFailures,
    };

    this.results.set(key, status);

    // Update the load balancer with the health status
    loadBalancer.setHealth(service.name, upstreamUrl, healthy);

    if (!healthy && consecutiveFailures >= 3) {
      logger.warn(
        `Upstream ${upstreamUrl} for ${service.name} has ${consecutiveFailures} consecutive failures`
      );
    }
  }

  /**
   * Perform a simple HTTP GET request and return the status code.
   */
  private httpGet(url: string): Promise<number> {
    return new Promise((resolve, reject) => {
      const isHttps = url.startsWith('https');
      const client = isHttps ? https : http;

      const request = client.get(url, { timeout: this.checkTimeout }, (response) => {
        resolve(response.statusCode || 0);
        // Consume the response to free up the socket
        response.resume();
      });

      request.on('error', (err) => {
        reject(err);
      });

      request.on('timeout', () => {
        request.destroy();
        reject(new Error(`Health check timed out after ${this.checkTimeout}ms`));
      });
    });
  }

  /**
   * Get health status for all upstreams.
   */
  getAllStatus(): HealthStatus[] {
    return Array.from(this.results.values());
  }

  /**
   * Get health status for a specific service.
   */
  getServiceStatus(serviceName: string): HealthStatus[] {
    return Array.from(this.results.values()).filter(
      (status) => status.service === serviceName
    );
  }

  /**
   * Get a summary of overall health.
   */
  getSummary(): {
    total: number;
    healthy: number;
    unhealthy: number;
    services: Record<string, { healthy: number; total: number }>;
  } {
    const all = this.getAllStatus();
    const healthy = all.filter((s) => s.healthy).length;

    const services: Record<string, { healthy: number; total: number }> = {};
    for (const status of all) {
      if (!services[status.service]) {
        services[status.service] = { healthy: 0, total: 0 };
      }
      services[status.service].total++;
      if (status.healthy) {
        services[status.service].healthy++;
      }
    }

    return {
      total: all.length,
      healthy,
      unhealthy: all.length - healthy,
      services,
    };
  }
}

/** Singleton health checker instance. */
export const healthChecker = new HealthChecker();
