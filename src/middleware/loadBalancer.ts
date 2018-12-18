import { ServiceConfig } from '../types/index';
import { logger } from '../utils/logger';

/**
 * Round-robin load balancer for distributing requests across multiple upstream instances.
 *
 * Each service with multiple upstreams gets its own round-robin counter.
 * Unhealthy upstreams can be marked and skipped.
 */

interface UpstreamState {
  url: string;
  healthy: boolean;
  weight: number;
  activeConnections: number;
}

class LoadBalancer {
  /** Maps service name -> array of upstream states. */
  private upstreams: Map<string, UpstreamState[]> = new Map();
  /** Maps service name -> current round-robin index. */
  private counters: Map<string, number> = new Map();

  /**
   * Initialize upstreams for a service from its config.
   */
  registerService(config: ServiceConfig): void {
    const states: UpstreamState[] = config.upstreams.map((url) => ({
      url,
      healthy: true,
      weight: 1,
      activeConnections: 0,
    }));
    this.upstreams.set(config.name, states);
    this.counters.set(config.name, 0);
  }

  /**
   * Get the next upstream URL for a service using round-robin.
   * Skips unhealthy upstreams. Returns undefined if all are unhealthy.
   */
  getNextUpstream(serviceName: string): string | undefined {
    const states = this.upstreams.get(serviceName);
    if (!states || states.length === 0) {
      return undefined;
    }

    // If only one upstream, return it directly (if healthy)
    if (states.length === 1) {
      return states[0].healthy ? states[0].url : undefined;
    }

    const totalUpstreams = states.length;
    let counter = this.counters.get(serviceName) || 0;
    let attempts = 0;

    // Try each upstream at most once
    while (attempts < totalUpstreams) {
      const index = counter % totalUpstreams;
      counter++;
      attempts++;

      if (states[index].healthy) {
        this.counters.set(serviceName, counter);
        states[index].activeConnections++;
        logger.debug(`Load balancer selected upstream ${index} for ${serviceName}`, {
          url: states[index].url,
          activeConnections: states[index].activeConnections,
        });
        return states[index].url;
      }
    }

    // All upstreams are unhealthy
    logger.error(`All upstreams unhealthy for service: ${serviceName}`);
    return undefined;
  }

  /**
   * Mark an upstream as healthy or unhealthy.
   */
  setHealth(serviceName: string, upstreamUrl: string, healthy: boolean): void {
    const states = this.upstreams.get(serviceName);
    if (!states) return;

    const upstream = states.find((s) => s.url === upstreamUrl);
    if (upstream) {
      const previousState = upstream.healthy;
      upstream.healthy = healthy;

      if (previousState !== healthy) {
        logger.info(
          `Upstream ${upstreamUrl} for ${serviceName} is now ${healthy ? 'HEALTHY' : 'UNHEALTHY'}`
        );
      }
    }
  }

  /**
   * Record that a connection to an upstream has completed.
   */
  releaseConnection(serviceName: string, upstreamUrl: string): void {
    const states = this.upstreams.get(serviceName);
    if (!states) return;

    const upstream = states.find((s) => s.url === upstreamUrl);
    if (upstream && upstream.activeConnections > 0) {
      upstream.activeConnections--;
    }
  }

  /**
   * Get the status of all upstreams for a service.
   */
  getServiceStatus(serviceName: string): UpstreamState[] {
    return this.upstreams.get(serviceName) || [];
  }

  /**
   * Get status of all services and their upstreams.
   */
  getAllStatus(): Record<string, UpstreamState[]> {
    const result: Record<string, UpstreamState[]> = {};
    for (const [name, states] of this.upstreams) {
      result[name] = states.map((s) => ({ ...s }));
    }
    return result;
  }

  /**
   * Get the number of healthy upstreams for a service.
   */
  healthyCount(serviceName: string): number {
    const states = this.upstreams.get(serviceName);
    if (!states) return 0;
    return states.filter((s) => s.healthy).length;
  }

  /**
   * Remove a service from the load balancer.
   */
  removeService(serviceName: string): void {
    this.upstreams.delete(serviceName);
    this.counters.delete(serviceName);
  }

  /**
   * Reset all state.
   */
  clear(): void {
    this.upstreams.clear();
    this.counters.clear();
  }
}

/** Singleton load balancer instance. */
export const loadBalancer = new LoadBalancer();
