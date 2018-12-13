/**
 * Configuration for a backend service registered with the gateway.
 */
export interface ServiceConfig {
  /** Unique name for the service (e.g., 'users', 'orders'). */
  name: string;
  /** URL prefix that routes to this service (e.g., '/api/users'). */
  prefix: string;
  /** Upstream server URL(s). Multiple URLs enable load balancing. */
  upstreams: string[];
  /** Whether requests to this service require JWT authentication. */
  authRequired: boolean;
  /** Rate limit: max requests per window. 0 = unlimited. */
  rateLimit: number;
  /** Rate limit window in milliseconds (default: 60000 = 1 minute). */
  rateLimitWindow: number;
  /** Whether to strip the prefix before forwarding to upstream. */
  stripPrefix: boolean;
  /** Additional headers to add to proxied requests. */
  headers?: Record<string, string>;
  /** Health check endpoint path on the upstream (e.g., '/health'). */
  healthCheckPath?: string;
  /** Circuit breaker: failure threshold before opening the circuit. */
  circuitBreakerThreshold: number;
  /** Circuit breaker: time in ms to wait before trying half-open. */
  circuitBreakerTimeout: number;
  /** Whether this service is enabled. */
  enabled: boolean;
}

/**
 * Options for the API gateway.
 */
export interface GatewayOptions {
  /** Port to listen on. */
  port: number;
  /** JWT secret for token verification. */
  jwtSecret: string;
  /** Global rate limit (requests per minute). 0 = unlimited. */
  globalRateLimit: number;
  /** Whether to enable request logging. */
  logging: boolean;
  /** CORS allowed origins. */
  corsOrigins: string[];
  /** Health check interval in milliseconds. */
  healthCheckInterval: number;
}

/**
 * Health status for an upstream service.
 */
export interface HealthStatus {
  /** Service name. */
  service: string;
  /** Upstream URL. */
  url: string;
  /** Whether the upstream is healthy. */
  healthy: boolean;
  /** HTTP status code from the last health check. */
  lastStatusCode: number;
  /** Response time in ms from the last health check. */
  lastResponseTime: number;
  /** Timestamp of the last successful check. */
  lastChecked: Date;
  /** Number of consecutive failures. */
  consecutiveFailures: number;
}

/**
 * Circuit breaker state.
 */
export type CircuitState = 'closed' | 'open' | 'half-open';

/**
 * Circuit breaker status for a service.
 */
export interface CircuitBreakerStatus {
  service: string;
  state: CircuitState;
  failures: number;
  threshold: number;
  lastFailure: Date | null;
  nextRetry: Date | null;
}

/**
 * Rate limit info for a client.
 */
export interface RateLimitInfo {
  /** Number of requests remaining in the current window. */
  remaining: number;
  /** Total allowed requests in the window. */
  limit: number;
  /** Timestamp when the window resets (ms since epoch). */
  resetAt: number;
}

/**
 * JWT payload structure expected by the gateway.
 */
export interface JWTPayload {
  sub: string;
  iat: number;
  exp: number;
  roles?: string[];
  [key: string]: unknown;
}
