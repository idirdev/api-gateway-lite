import { Request, Response, NextFunction } from 'express';
import { ServiceConfig, GatewayOptions } from './types/index';
import { serviceRegistry } from './config/services';
import { loadBalancer } from './middleware/loadBalancer';
import { circuitBreakerManager } from './middleware/circuitBreaker';
import { healthChecker } from './health/checker';
import { logger } from './utils/logger';

/**
 * Default gateway options.
 */
const DEFAULT_OPTIONS: GatewayOptions = {
  port: 3000,
  jwtSecret: process.env.JWT_SECRET || 'change-me-in-production',
  globalRateLimit: 1000,
  logging: true,
  corsOrigins: ['*'],
  healthCheckInterval: 30_000,
};

/**
 * The Gateway class orchestrates all middleware components:
 * - Service discovery/registry
 * - Load balancing
 * - Circuit breaking
 * - Health checking
 *
 * It provides the service resolver middleware that identifies which
 * backend service should handle each incoming request.
 */
export class Gateway {
  private options: GatewayOptions;
  private initialized: boolean = false;

  constructor(options: Partial<GatewayOptions> = {}) {
    this.options = { ...DEFAULT_OPTIONS, ...options };
  }

  /**
   * Initialize the gateway: register services with load balancer and circuit breaker,
   * and start health checks.
   */
  initialize(): void {
    if (this.initialized) return;

    const services = serviceRegistry.getEnabled();

    for (const service of services) {
      // Register with load balancer
      loadBalancer.registerService(service);

      // Register circuit breaker
      circuitBreakerManager.register(
        service.name,
        service.circuitBreakerThreshold,
        service.circuitBreakerTimeout
      );

      logger.info(`Registered service: ${service.name}`, {
        prefix: service.prefix,
        upstreams: service.upstreams.length,
        authRequired: service.authRequired,
        rateLimit: service.rateLimit,
      });
    }

    // Start health checks
    healthChecker.start(services, this.options.healthCheckInterval);

    this.initialized = true;
    logger.info(`Gateway initialized with ${services.length} services`);
  }

  /**
   * Get the gateway options.
   */
  getOptions(): GatewayOptions {
    return { ...this.options };
  }

  /**
   * Middleware that resolves which service should handle the incoming request.
   * Attaches the service config to the request object for downstream middleware.
   */
  serviceResolver() {
    return (req: Request, _res: Response, next: NextFunction): void => {
      const service = serviceRegistry.findByPath(req.path);

      if (service) {
        (req as any).__gatewayService = service;
        logger.debug(`Resolved service: ${service.name} for ${req.path}`);
      }

      next();
    };
  }

  /**
   * Add a new service to the gateway at runtime.
   */
  addService(config: ServiceConfig): void {
    serviceRegistry.register(config);
    loadBalancer.registerService(config);
    circuitBreakerManager.register(
      config.name,
      config.circuitBreakerThreshold,
      config.circuitBreakerTimeout
    );
    logger.info(`Dynamically added service: ${config.name}`);
  }

  /**
   * Remove a service from the gateway at runtime.
   */
  removeService(name: string): boolean {
    const removed = serviceRegistry.remove(name);
    if (removed) {
      loadBalancer.removeService(name);
      circuitBreakerManager.remove(name);
      logger.info(`Removed service: ${name}`);
    }
    return removed;
  }

  /**
   * Get gateway status including all services, health, and circuit breakers.
   */
  getStatus(): Record<string, unknown> {
    return {
      uptime: process.uptime(),
      services: serviceRegistry.getAll().map((s) => ({
        name: s.name,
        prefix: s.prefix,
        enabled: s.enabled,
        upstreams: s.upstreams.length,
        authRequired: s.authRequired,
        rateLimit: s.rateLimit,
      })),
      health: healthChecker.getSummary(),
      circuitBreakers: circuitBreakerManager.getAllStatus(),
      loadBalancer: loadBalancer.getAllStatus(),
    };
  }

  /**
   * Shut down the gateway gracefully.
   */
  shutdown(): void {
    healthChecker.stop();
    loadBalancer.clear();
    circuitBreakerManager.clear();
    this.initialized = false;
    logger.info('Gateway shut down');
  }
}
