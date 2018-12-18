import { Request, Response, NextFunction } from 'express';
import { createProxyMiddleware, Options } from 'http-proxy-middleware';
import { ServiceConfig } from '../types/index';
import { loadBalancer } from './loadBalancer';
import { circuitBreakerManager } from './circuitBreaker';
import { logger } from '../utils/logger';

/**
 * Dynamic proxy middleware for the API gateway.
 *
 * Routes incoming requests to the appropriate upstream service based on
 * the service config attached to the request. Uses the load balancer to
 * select the upstream and integrates with the circuit breaker for
 * failure tracking.
 */

/**
 * Cache of proxy middleware instances per upstream URL to avoid recreation.
 */
const proxyCache: Map<string, ReturnType<typeof createProxyMiddleware>> = new Map();

/**
 * Create or retrieve a cached proxy middleware for a given upstream URL.
 */
function getOrCreateProxy(
  upstreamUrl: string,
  serviceConfig: ServiceConfig
): ReturnType<typeof createProxyMiddleware> {
  const cacheKey = `${serviceConfig.name}:${upstreamUrl}`;

  if (proxyCache.has(cacheKey)) {
    return proxyCache.get(cacheKey)!;
  }

  const pathRewrite: Record<string, string> = {};
  if (serviceConfig.stripPrefix) {
    pathRewrite[`^${serviceConfig.prefix}`] = '';
  }

  const proxyOptions: Options = {
    target: upstreamUrl,
    changeOrigin: true,
    pathRewrite,
    timeout: 30_000,
    proxyTimeout: 30_000,
    on: {
      proxyReq: (proxyReq, req) => {
        // Add gateway identification headers
        proxyReq.setHeader('X-Forwarded-By', 'api-gateway-lite');
        proxyReq.setHeader('X-Gateway-Service', serviceConfig.name);
        proxyReq.setHeader('X-Request-Start', Date.now().toString());

        // Add any custom headers from the service config
        if (serviceConfig.headers) {
          for (const [key, value] of Object.entries(serviceConfig.headers)) {
            proxyReq.setHeader(key, value);
          }
        }

        logger.debug(`Proxying ${req.method} ${req.url} -> ${upstreamUrl}`, {
          service: serviceConfig.name,
        });
      },
      proxyRes: (proxyRes, req) => {
        const startTime = parseInt(
          (req.headers['x-request-start'] as string) || '0'
        );
        const duration = startTime > 0 ? Date.now() - startTime : 0;

        // Record success/failure with circuit breaker
        const statusCode = proxyRes.statusCode || 0;
        if (statusCode >= 500) {
          circuitBreakerManager.recordFailure(serviceConfig.name);
        } else {
          circuitBreakerManager.recordSuccess(serviceConfig.name);
        }

        // Release the load balancer connection
        loadBalancer.releaseConnection(serviceConfig.name, upstreamUrl);

        // Add response headers
        proxyRes.headers['x-gateway-service'] = serviceConfig.name;
        proxyRes.headers['x-gateway-upstream'] = upstreamUrl;
        if (duration > 0) {
          proxyRes.headers['x-gateway-duration'] = `${duration}ms`;
        }

        logger.request(
          req.method || 'UNKNOWN',
          req.url || '/',
          statusCode,
          duration,
          { service: serviceConfig.name, upstream: upstreamUrl }
        );
      },
      error: (err, req, res) => {
        circuitBreakerManager.recordFailure(serviceConfig.name);
        loadBalancer.releaseConnection(serviceConfig.name, upstreamUrl);

        logger.error(`Proxy error for ${serviceConfig.name}: ${err.message}`, {
          upstream: upstreamUrl,
          path: (req as any).url,
        });

        if (res && 'status' in res && typeof res.status === 'function') {
          (res as Response).status(502).json({
            error: 'Bad Gateway',
            message: `Failed to connect to upstream service "${serviceConfig.name}"`,
            upstream: upstreamUrl,
          });
        }
      },
    },
  };

  const proxy = createProxyMiddleware(proxyOptions);
  proxyCache.set(cacheKey, proxy);
  return proxy;
}

/**
 * Create the dynamic proxy middleware that routes requests to upstreams.
 */
export function createProxyHandler() {
  return (req: Request, res: Response, next: NextFunction): void => {
    const serviceConfig = (req as any).__gatewayService as ServiceConfig | undefined;

    if (!serviceConfig) {
      next();
      return;
    }

    // Get the next upstream from the load balancer
    const upstreamUrl = loadBalancer.getNextUpstream(serviceConfig.name);

    if (!upstreamUrl) {
      logger.error(`No healthy upstream available for ${serviceConfig.name}`);
      res.status(503).json({
        error: 'Service Unavailable',
        message: `No healthy upstream available for service "${serviceConfig.name}"`,
      });
      return;
    }

    // Store the selected upstream on the request for tracking
    (req as any).__gatewayUpstream = upstreamUrl;
    req.headers['x-request-start'] = Date.now().toString();

    // Get or create the proxy and forward the request
    const proxy = getOrCreateProxy(upstreamUrl, serviceConfig);
    proxy(req, res, next);
  };
}
