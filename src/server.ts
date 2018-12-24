import express, { Request, Response, NextFunction } from 'express';
import { Gateway } from './gateway';
import { createAuthMiddleware } from './middleware/auth';
import { createRateLimiter } from './middleware/rateLimit';
import { createCircuitBreakerMiddleware } from './middleware/circuitBreaker';
import { createProxyHandler } from './middleware/proxy';
import { logger } from './utils/logger';

const app = express();

// ─── Initialize Gateway ─────────────────────────────────────────────────────
const gateway = new Gateway({
  port: parseInt(process.env.PORT || '3000'),
  jwtSecret: process.env.JWT_SECRET || 'super-secret-key-change-in-production',
  globalRateLimit: 1000,
  logging: true,
  corsOrigins: ['*'],
  healthCheckInterval: 30_000,
});

const gatewayOptions = gateway.getOptions();

// Initialize services, load balancer, circuit breakers, health checks
gateway.initialize();

// ─── Global Middleware ──────────────────────────────────────────────────────

// CORS
app.use((_req: Request, res: Response, next: NextFunction) => {
  res.setHeader('Access-Control-Allow-Origin', gatewayOptions.corsOrigins.join(','));
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, PATCH, OPTIONS');
  res.setHeader(
    'Access-Control-Allow-Headers',
    'Content-Type, Authorization, X-Request-ID'
  );
  res.setHeader('Access-Control-Expose-Headers', [
    'X-RateLimit-Limit',
    'X-RateLimit-Remaining',
    'X-RateLimit-Reset',
    'X-Gateway-Service',
    'X-Gateway-Duration',
  ].join(','));

  if (_req.method === 'OPTIONS') {
    res.status(204).end();
    return;
  }
  next();
});

// Request ID
app.use((req: Request, _res: Response, next: NextFunction) => {
  if (!req.headers['x-request-id']) {
    req.headers['x-request-id'] = `gw-${Date.now()}-${Math.random().toString(36).substring(2, 8)}`;
  }
  next();
});

// Request logging
app.use((req: Request, res: Response, next: NextFunction) => {
  const start = Date.now();
  res.on('finish', () => {
    logger.request(req.method, req.path, res.statusCode, Date.now() - start, {
      requestId: req.headers['x-request-id'],
    });
  });
  next();
});

// Body parsing (for non-proxied routes)
app.use(express.json({ limit: '10mb' }));

// ─── Gateway Management Routes ──────────────────────────────────────────────

// Gateway info
app.get('/', (_req: Request, res: Response) => {
  res.json({
    name: 'API Gateway Lite',
    version: '1.0.0',
    description: 'Lightweight API gateway with routing, auth, and rate limiting',
    endpoints: {
      health: 'GET /gateway/health',
      status: 'GET /gateway/status',
      services: 'GET /gateway/services',
    },
  });
});

// Health check
app.get('/gateway/health', (_req: Request, res: Response) => {
  res.json({
    status: 'healthy',
    uptime: process.uptime(),
    timestamp: new Date().toISOString(),
  });
});

// Detailed status
app.get('/gateway/status', (_req: Request, res: Response) => {
  res.json(gateway.getStatus());
});

// List services
app.get('/gateway/services', (_req: Request, res: Response) => {
  const status = gateway.getStatus();
  res.json({
    services: status.services,
  });
});

// ─── API Proxy Pipeline ─────────────────────────────────────────────────────
// The order matters: resolve service -> auth -> rate limit -> circuit breaker -> proxy

// 1. Service resolver: identify which backend service handles this request
app.use(gateway.serviceResolver());

// 2. Authentication: verify JWT if the service requires it
app.use(createAuthMiddleware(gatewayOptions.jwtSecret));

// 3. Rate limiting: enforce per-service or global rate limits
app.use(createRateLimiter(gatewayOptions.globalRateLimit));

// 4. Circuit breaker: reject requests if the service is in a failure state
app.use(createCircuitBreakerMiddleware());

// 5. Proxy: forward the request to the upstream service
app.use(createProxyHandler());

// ─── Fallback: No matching service ──────────────────────────────────────────
app.use((req: Request, res: Response) => {
  res.status(404).json({
    error: 'Not Found',
    message: `No service registered for path: ${req.path}`,
    hint: 'GET /gateway/services to see available routes',
  });
});

// ─── Error handler ──────────────────────────────────────────────────────────
app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
  logger.error(`Unhandled error: ${err.message}`, { stack: err.stack });
  res.status(500).json({
    error: 'Internal Gateway Error',
    message: process.env.NODE_ENV === 'development' ? err.message : 'An unexpected error occurred',
  });
});

// ─── Start ──────────────────────────────────────────────────────────────────
const PORT = gatewayOptions.port;
app.listen(PORT, () => {
  logger.info(`API Gateway Lite running on http://localhost:${PORT}`);
  logger.info(`Management dashboard: http://localhost:${PORT}/gateway/status`);
});

// Graceful shutdown
process.on('SIGTERM', () => {
  logger.info('SIGTERM received, shutting down...');
  gateway.shutdown();
  process.exit(0);
});

process.on('SIGINT', () => {
  logger.info('SIGINT received, shutting down...');
  gateway.shutdown();
  process.exit(0);
});

export default app;
