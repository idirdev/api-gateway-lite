import { describe, it, expect, beforeEach } from 'vitest';
import { circuitBreakerManager } from '../src/middleware/circuitBreaker';
import { loadBalancer } from '../src/middleware/loadBalancer';
import type { ServiceConfig } from '../src/types/index';

function createServiceConfig(overrides: Partial<ServiceConfig> = {}): ServiceConfig {
  return {
    name: 'test-service',
    prefix: '/api/test',
    upstreams: ['http://localhost:3001'],
    authRequired: false,
    rateLimit: 100,
    rateLimitWindow: 60000,
    stripPrefix: true,
    circuitBreakerThreshold: 5,
    circuitBreakerTimeout: 30000,
    enabled: true,
    ...overrides,
  };
}

describe('CircuitBreakerManager', () => {
  beforeEach(() => {
    circuitBreakerManager.clear();
  });

  it('starts in closed state after registration', () => {
    circuitBreakerManager.register('svc-a', 5, 30000);
    const status = circuitBreakerManager.getStatus('svc-a');
    expect(status).toBeDefined();
    expect(status!.state).toBe('closed');
    expect(status!.failures).toBe(0);
  });

  it('allows requests when circuit is closed', () => {
    circuitBreakerManager.register('svc-a', 3, 30000);
    expect(circuitBreakerManager.allowRequest('svc-a')).toBe(true);
  });

  it('opens circuit after reaching failure threshold', () => {
    circuitBreakerManager.register('svc-b', 3, 30000);

    circuitBreakerManager.recordFailure('svc-b');
    circuitBreakerManager.recordFailure('svc-b');
    circuitBreakerManager.recordFailure('svc-b');

    const status = circuitBreakerManager.getStatus('svc-b');
    expect(status!.state).toBe('open');
  });

  it('rejects requests when circuit is open', () => {
    circuitBreakerManager.register('svc-c', 2, 60000);

    circuitBreakerManager.recordFailure('svc-c');
    circuitBreakerManager.recordFailure('svc-c');

    expect(circuitBreakerManager.allowRequest('svc-c')).toBe(false);
  });

  it('transitions to half-open after timeout expires', () => {
    circuitBreakerManager.register('svc-d', 1, 1); // 1ms timeout

    circuitBreakerManager.recordFailure('svc-d');
    expect(circuitBreakerManager.getStatus('svc-d')!.state).toBe('open');

    // Wait briefly for the timeout to expire
    const start = Date.now();
    while (Date.now() - start < 5) { /* spin */ }

    // allowRequest should transition to half-open and return true
    expect(circuitBreakerManager.allowRequest('svc-d')).toBe(true);
    expect(circuitBreakerManager.getStatus('svc-d')!.state).toBe('half-open');
  });

  it('closes circuit on success in half-open state', () => {
    circuitBreakerManager.register('svc-e', 1, 1);

    circuitBreakerManager.recordFailure('svc-e');
    const start = Date.now();
    while (Date.now() - start < 5) { /* spin */ }
    circuitBreakerManager.allowRequest('svc-e'); // transition to half-open

    circuitBreakerManager.recordSuccess('svc-e');
    expect(circuitBreakerManager.getStatus('svc-e')!.state).toBe('closed');
  });

  it('re-opens circuit on failure in half-open state', () => {
    circuitBreakerManager.register('svc-f', 1, 1);

    circuitBreakerManager.recordFailure('svc-f');
    const start = Date.now();
    while (Date.now() - start < 5) { /* spin */ }
    circuitBreakerManager.allowRequest('svc-f'); // transition to half-open

    circuitBreakerManager.recordFailure('svc-f');
    expect(circuitBreakerManager.getStatus('svc-f')!.state).toBe('open');
  });

  it('manually resets a circuit breaker', () => {
    circuitBreakerManager.register('svc-g', 1, 60000);
    circuitBreakerManager.recordFailure('svc-g');
    expect(circuitBreakerManager.getStatus('svc-g')!.state).toBe('open');

    circuitBreakerManager.reset('svc-g');
    expect(circuitBreakerManager.getStatus('svc-g')!.state).toBe('closed');
    expect(circuitBreakerManager.getStatus('svc-g')!.failures).toBe(0);
  });

  it('returns undefined for unregistered services', () => {
    expect(circuitBreakerManager.getStatus('nonexistent')).toBeUndefined();
  });

  it('allows requests for unregistered services', () => {
    expect(circuitBreakerManager.allowRequest('nonexistent')).toBe(true);
  });

  it('getAllStatus returns all registered breakers', () => {
    circuitBreakerManager.register('svc-1', 5, 30000);
    circuitBreakerManager.register('svc-2', 3, 10000);
    const all = circuitBreakerManager.getAllStatus();
    expect(all).toHaveLength(2);
    expect(all.map((s) => s.service)).toContain('svc-1');
    expect(all.map((s) => s.service)).toContain('svc-2');
  });
});

describe('LoadBalancer', () => {
  beforeEach(() => {
    loadBalancer.clear();
  });

  it('returns the single upstream for a single-upstream service', () => {
    const config = createServiceConfig({
      name: 'single',
      upstreams: ['http://localhost:3001'],
    });
    loadBalancer.registerService(config);
    expect(loadBalancer.getNextUpstream('single')).toBe('http://localhost:3001');
  });

  it('round-robins across multiple upstreams', () => {
    const config = createServiceConfig({
      name: 'multi',
      upstreams: ['http://a:3000', 'http://b:3000', 'http://c:3000'],
    });
    loadBalancer.registerService(config);

    const first = loadBalancer.getNextUpstream('multi');
    const second = loadBalancer.getNextUpstream('multi');
    const third = loadBalancer.getNextUpstream('multi');
    const fourth = loadBalancer.getNextUpstream('multi');

    expect(first).toBe('http://a:3000');
    expect(second).toBe('http://b:3000');
    expect(third).toBe('http://c:3000');
    // Wraps around
    expect(fourth).toBe('http://a:3000');
  });

  it('skips unhealthy upstreams', () => {
    const config = createServiceConfig({
      name: 'partial',
      upstreams: ['http://a:3000', 'http://b:3000', 'http://c:3000'],
    });
    loadBalancer.registerService(config);

    loadBalancer.setHealth('partial', 'http://b:3000', false);

    const results: string[] = [];
    for (let i = 0; i < 4; i++) {
      const upstream = loadBalancer.getNextUpstream('partial');
      if (upstream) results.push(upstream);
    }
    expect(results).not.toContain('http://b:3000');
  });

  it('returns undefined when all upstreams are unhealthy', () => {
    const config = createServiceConfig({
      name: 'down',
      upstreams: ['http://a:3000', 'http://b:3000'],
    });
    loadBalancer.registerService(config);

    loadBalancer.setHealth('down', 'http://a:3000', false);
    loadBalancer.setHealth('down', 'http://b:3000', false);

    expect(loadBalancer.getNextUpstream('down')).toBeUndefined();
  });

  it('returns undefined for unknown service', () => {
    expect(loadBalancer.getNextUpstream('unknown')).toBeUndefined();
  });

  it('tracks healthy count', () => {
    const config = createServiceConfig({
      name: 'counted',
      upstreams: ['http://a:3000', 'http://b:3000', 'http://c:3000'],
    });
    loadBalancer.registerService(config);

    expect(loadBalancer.healthyCount('counted')).toBe(3);
    loadBalancer.setHealth('counted', 'http://a:3000', false);
    expect(loadBalancer.healthyCount('counted')).toBe(2);
  });

  it('removes a service', () => {
    const config = createServiceConfig({ name: 'removable' });
    loadBalancer.registerService(config);
    expect(loadBalancer.getNextUpstream('removable')).toBeDefined();

    loadBalancer.removeService('removable');
    expect(loadBalancer.getNextUpstream('removable')).toBeUndefined();
  });

  it('returns status of all upstreams', () => {
    const config = createServiceConfig({
      name: 'status-check',
      upstreams: ['http://a:3000', 'http://b:3000'],
    });
    loadBalancer.registerService(config);
    const status = loadBalancer.getServiceStatus('status-check');
    expect(status).toHaveLength(2);
    expect(status[0].healthy).toBe(true);
    expect(status[1].healthy).toBe(true);
  });
});
