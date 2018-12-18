import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { JWTPayload } from '../types/index';
import { logger } from '../utils/logger';

/**
 * JWT authentication middleware for the API Gateway.
 *
 * Validates the JWT token from the Authorization header (Bearer scheme).
 * If valid, attaches the decoded payload to req.user for downstream handlers.
 * If the service does not require auth, this middleware is a passthrough.
 */

/**
 * Create a JWT auth middleware with the given secret.
 *
 * @param jwtSecret - The secret key used to verify JWT tokens
 * @returns Express middleware function
 */
export function createAuthMiddleware(jwtSecret: string) {
  return (req: Request, res: Response, next: NextFunction): void => {
    // Extract the service config from the request (attached by the gateway)
    const serviceConfig = (req as any).__gatewayService;

    // If no service config found or auth not required, skip
    if (!serviceConfig || !serviceConfig.authRequired) {
      next();
      return;
    }

    // Get the Authorization header
    const authHeader = req.headers.authorization;

    if (!authHeader) {
      logger.warn('Missing Authorization header', {
        path: req.path,
        ip: req.ip,
      });
      res.status(401).json({
        error: 'Unauthorized',
        message: 'Missing Authorization header. Expected: Bearer <token>',
      });
      return;
    }

    // Validate Bearer scheme
    const parts = authHeader.split(' ');
    if (parts.length !== 2 || parts[0] !== 'Bearer') {
      res.status(401).json({
        error: 'Unauthorized',
        message: 'Invalid Authorization format. Expected: Bearer <token>',
      });
      return;
    }

    const token = parts[1];

    try {
      // Verify and decode the JWT
      const decoded = jwt.verify(token, jwtSecret, {
        algorithms: ['HS256', 'HS384', 'HS512'],
      }) as JWTPayload;

      // Check if the token has required claims
      if (!decoded.sub) {
        res.status(401).json({
          error: 'Unauthorized',
          message: 'Token is missing required "sub" claim',
        });
        return;
      }

      // Attach decoded payload to the request for downstream use
      (req as any).user = {
        id: decoded.sub,
        roles: decoded.roles || [],
        tokenIssuedAt: new Date(decoded.iat * 1000),
        tokenExpiresAt: new Date(decoded.exp * 1000),
        claims: decoded,
      };

      // Add user info to proxy headers so upstream services can access it
      req.headers['x-gateway-user-id'] = decoded.sub;
      if (decoded.roles && decoded.roles.length > 0) {
        req.headers['x-gateway-user-roles'] = decoded.roles.join(',');
      }
      req.headers['x-gateway-authenticated'] = 'true';

      logger.debug('JWT verified', {
        userId: decoded.sub,
        path: req.path,
      });

      next();
    } catch (error) {
      if (error instanceof jwt.TokenExpiredError) {
        logger.warn('Expired JWT token', { path: req.path, ip: req.ip });
        res.status(401).json({
          error: 'Unauthorized',
          message: 'Token has expired',
        });
        return;
      }

      if (error instanceof jwt.JsonWebTokenError) {
        logger.warn('Invalid JWT token', {
          path: req.path,
          ip: req.ip,
          error: (error as Error).message,
        });
        res.status(401).json({
          error: 'Unauthorized',
          message: 'Invalid token',
        });
        return;
      }

      logger.error('JWT verification error', {
        error: (error as Error).message,
      });
      res.status(500).json({
        error: 'Internal server error',
        message: 'Failed to verify token',
      });
    }
  };
}
