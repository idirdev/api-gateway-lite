import { ServiceConfig } from '../types/index';

/**
 * Service registry — defines all backend services the gateway routes to.
 *
 * In production, this would be loaded from a config file, database,
 * or service discovery system (e.g., Consul, etcd).
 * Here we define a static example registry for demonstration.
 */

const services: ServiceConfig[] = [
  {
    name: 'users',
    prefix: '/api/users',
    upstreams: ['http://localhost:4001'],
    authRequired: true,
    rateLimit: 100,
    rateLimitWindow: 60_000,
    stripPrefix: true,
    healthCheckPath: '/health',
    circuitBreakerThreshold: 5,
    circuitBreakerTimeout: 30_000,
    enabled: true,
  },
  {
    name: 'orders',
    prefix: '/api/orders',
    upstreams: ['http://localhost:4002', 'http://localhost:4003'],
    authRequired: true,
    rateLimit: 200,
    rateLimitWindow: 60_000,
    stripPrefix: true,
    healthCheckPath: '/health',
    circuitBreakerThreshold: 5,
    circuitBreakerTimeout: 30_000,
    enabled: true,
  },
  {
    name: 'products',
    prefix: '/api/products',
    upstreams: ['http://localhost:4004'],
    authRequired: false,
    rateLimit: 500,
    rateLimitWindow: 60_000,
    stripPrefix: true,
    healthCheckPath: '/health',
    circuitBreakerThreshold: 10,
    circuitBreakerTimeout: 60_000,
    enabled: true,
  },
  {
    name: 'auth',
    prefix: '/api/auth',
    upstreams: ['http://localhost:4005'],
    authRequired: false,
    rateLimit: 30,
    rateLimitWindow: 60_000,
    stripPrefix: true,
    healthCheckPath: '/health',
    circuitBreakerThreshold: 3,
    circuitBreakerTimeout: 15_000,
    enabled: true,
  },
];

/**
 * In-memory service registry with CRUD operations.
 */
class ServiceRegistry {
  private services: Map<string, ServiceConfig> = new Map();

  constructor(initialServices: ServiceConfig[] = []) {
    for (const service of initialServices) {
      this.services.set(service.name, service);
    }
  }

  /**
   * Get all registered services.
   */
  getAll(): ServiceConfig[] {
    return Array.from(this.services.values());
  }

  /**
   * Get only enabled services.
   */
  getEnabled(): ServiceConfig[] {
    return this.getAll().filter((s) => s.enabled);
  }

  /**
   * Get a service by name.
   */
  getByName(name: string): ServiceConfig | undefined {
    return this.services.get(name);
  }

  /**
   * Find which service handles a given request path.
   */
  findByPath(path: string): ServiceConfig | undefined {
    for (const service of this.services.values()) {
      if (service.enabled && path.startsWith(service.prefix)) {
        return service;
      }
    }
    return undefined;
  }

  /**
   * Register or update a service.
   */
  register(config: ServiceConfig): void {
    this.services.set(config.name, config);
  }

  /**
   * Remove a service by name.
   */
  remove(name: string): boolean {
    return this.services.delete(name);
  }

  /**
   * Toggle a service's enabled status.
   */
  toggle(name: string): ServiceConfig | undefined {
    const service = this.services.get(name);
    if (service) {
      service.enabled = !service.enabled;
      this.services.set(name, service);
    }
    return service;
  }

  /**
   * Get the total number of registered services.
   */
  count(): number {
    return this.services.size;
  }
}

/** Singleton service registry instance loaded with default services. */
export const serviceRegistry = new ServiceRegistry(services);
