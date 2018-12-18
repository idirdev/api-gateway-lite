import { Request, Response, NextFunction } from 'express';
import { CircuitState, CircuitBreakerStatus, ServiceConfig } from '../types/index';
import { logger } from '../utils/logger';

/**
 * Circuit Breaker pattern implementation.
 *
 * States:
 *   CLOSED   - Normal operation. Requests pass through. Failures are counted.
 *   OPEN     - Too many failures. Requests are immediately rejected.
 *   HALF-OPEN - After timeout, one test request is allowed through.
 *               If it succeeds, circuit closes. If it fails, circuit opens again.
 */

interface CircuitEntry {
  state: CircuitState;
  failureCount: number;
  successCount: number;
  lastFailureTime: number;
  lastAttemptTime: number;
  threshold: number;
  timeout: number;
}

class CircuitBreakerManager {
  private circuits: Map<string, CircuitEntry> = new Map();

  /**
   * Initialize a circuit breaker for a service.
   */
  register(serviceName: string, threshold: number, timeout: number): void {
    if (!this.circuits.has(serviceName)) {
      this.circuits.set(serviceName, {
        state: 'closed',
        failureCount: 0,
        successCount: 0,
        lastFailureTime: 0,
        lastAttemptTime: 0,
        threshold,
        timeout,
      });
    }
  }

  /**
   * Check if a request should be allowed through the circuit.
   * Returns true if allowed, false if the circuit is open and request should be rejected.
   */
  allowRequest(serviceName: string): boolean {
    const circuit = this.circuits.get(serviceName);
    if (!circuit) return true; // No circuit breaker configured

    switch (circuit.state) {
      case 'closed':
        return true;

      case 'open': {
        const now = Date.now();
        const timeSinceLastFailure = now - circuit.lastFailureTime;

        if (timeSinceLastFailure >= circuit.timeout) {
          // Transition to half-open: allow one test request
          circuit.state = 'half-open';
          circuit.lastAttemptTime = now;
          logger.info(`Circuit breaker for ${serviceName}: OPEN -> HALF-OPEN`);
          return true;
        }

        return false;
      }

      case 'half-open':
        // Only allow one request at a time in half-open
        // If a request is already in flight, reject additional ones
        return true;

      default:
        return true;
    }
  }

  /**
   * Record a successful request for a service.
   */
  recordSuccess(serviceName: string): void {
    const circuit = this.circuits.get(serviceName);
    if (!circuit) return;

    if (circuit.state === 'half-open') {
      // Success in half-open state: close the circuit
      circuit.state = 'closed';
      circuit.failureCount = 0;
      circuit.successCount = 1;
      logger.info(`Circuit breaker for ${serviceName}: HALF-OPEN -> CLOSED (success)`);
    } else if (circuit.state === 'closed') {
      circuit.successCount++;
      // Reset failure count on success in closed state
      if (circuit.failureCount > 0) {
        circuit.failureCount = Math.max(0, circuit.failureCount - 1);
      }
    }
  }

  /**
   * Record a failed request for a service.
   */
  recordFailure(serviceName: string): void {
    const circuit = this.circuits.get(serviceName);
    if (!circuit) return;

    circuit.failureCount++;
    circuit.lastFailureTime = Date.now();

    if (circuit.state === 'half-open') {
      // Failure in half-open: immediately open the circuit again
      circuit.state = 'open';
      logger.warn(`Circuit breaker for ${serviceName}: HALF-OPEN -> OPEN (failure)`);
    } else if (circuit.state === 'closed' && circuit.failureCount >= circuit.threshold) {
      // Threshold reached in closed state: open the circuit
      circuit.state = 'open';
      logger.warn(
        `Circuit breaker for ${serviceName}: CLOSED -> OPEN ` +
        `(${circuit.failureCount}/${circuit.threshold} failures)`
      );
    }
  }

  /**
   * Get the current status of a circuit breaker.
   */
  getStatus(serviceName: string): CircuitBreakerStatus | undefined {
    const circuit = this.circuits.get(serviceName);
    if (!circuit) return undefined;

    return {
      service: serviceName,
      state: circuit.state,
      failures: circuit.failureCount,
      threshold: circuit.threshold,
      lastFailure: circuit.lastFailureTime > 0 ? new Date(circuit.lastFailureTime) : null,
      nextRetry:
        circuit.state === 'open'
          ? new Date(circuit.lastFailureTime + circuit.timeout)
          : null,
    };
  }

  /**
   * Get status of all circuit breakers.
   */
  getAllStatus(): CircuitBreakerStatus[] {
    const statuses: CircuitBreakerStatus[] = [];
    for (const name of this.circuits.keys()) {
      const status = this.getStatus(name);
      if (status) statuses.push(status);
    }
    return statuses;
  }

  /**
   * Manually reset a circuit breaker to closed state.
   */
  reset(serviceName: string): void {
    const circuit = this.circuits.get(serviceName);
    if (circuit) {
      circuit.state = 'closed';
      circuit.failureCount = 0;
      circuit.successCount = 0;
      logger.info(`Circuit breaker for ${serviceName}: manually reset to CLOSED`);
    }
  }

  /**
   * Remove a circuit breaker.
   */
  remove(serviceName: string): void {
    this.circuits.delete(serviceName);
  }

  /**
   * Clear all circuit breakers.
   */
  clear(): void {
    this.circuits.clear();
  }
}

/** Singleton circuit breaker manager. */
export const circuitBreakerManager = new CircuitBreakerManager();

/**
 * Express middleware that checks the circuit breaker before allowing a request.
 */
export function createCircuitBreakerMiddleware() {
  return (req: Request, res: Response, next: NextFunction): void => {
    const serviceConfig = (req as any).__gatewayService as ServiceConfig | undefined;
    if (!serviceConfig) {
      next();
      return;
    }

    const allowed = circuitBreakerManager.allowRequest(serviceConfig.name);
    if (!allowed) {
      const status = circuitBreakerManager.getStatus(serviceConfig.name);
      const retryAfter = status?.nextRetry
        ? Math.ceil((status.nextRetry.getTime() - Date.now()) / 1000)
        : 30;

      logger.warn(`Circuit breaker OPEN: rejecting request to ${serviceConfig.name}`, {
        path: req.path,
      });

      res.setHeader('Retry-After', Math.max(1, retryAfter));
      res.status(503).json({
        error: 'Service Unavailable',
        message: `Service "${serviceConfig.name}" is temporarily unavailable. Circuit breaker is OPEN.`,
        retryAfter: Math.max(1, retryAfter),
      });
      return;
    }

    next();
  };
}
