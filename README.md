# 🚪 API Gateway Lite

[![TypeScript](https://img.shields.io/badge/TypeScript-5.4-blue.svg)](https://www.typescriptlang.org/)
[![Express](https://img.shields.io/badge/Express-4.18-green.svg)](https://expressjs.com/)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

A lightweight API gateway with reverse proxying, JWT authentication, per-service rate limiting, circuit breaker pattern, round-robin load balancing, and health checks.

## Features

- **Reverse Proxy** — Route requests to upstream backend services with path rewriting
- **JWT Authentication** — Per-service configurable JWT token verification (HS256/384/512)
- **Rate Limiting** — Sliding window rate limiter with per-service and global limits
- **Circuit Breaker** — Automatic failure detection with closed/open/half-open states
- **Load Balancing** — Round-robin distribution across multiple upstream instances
- **Health Checks** — Periodic upstream health monitoring with automatic failover
- **Service Registry** — Dynamic service registration and discovery
- **Request Logging** — Structured JSON logging with request timing

## Quick Start

```bash
npm install
npm run dev
```

Gateway starts on `http://localhost:3000`.

## Architecture

```
                    ┌─────────────────────────────────┐
                    │         API Gateway Lite         │
                    │                                  │
  Client Request    │  ┌──────────┐  ┌──────────────┐ │
  ──────────────────┤  │ Service  │──│     Auth     │ │
                    │  │ Resolver │  │  (JWT Check) │ │
                    │  └──────────┘  └──────────────┘ │
                    │       │               │         │
                    │  ┌──────────┐  ┌──────────────┐ │
                    │  │  Rate    │──│   Circuit    │ │
                    │  │ Limiter  │  │   Breaker    │ │
                    │  └──────────┘  └──────────────┘ │
                    │       │               │         │
                    │  ┌──────────┐  ┌──────────────┐ │
                    │  │  Load    │──│    Proxy     │───── Upstream A
                    │  │ Balancer │  │  (Forward)   │───── Upstream B
                    │  └──────────┘  └──────────────┘ │
                    │                                  │
                    │  ┌──────────────────────────────┐│
                    │  │     Health Checker           ││
                    │  │  (periodic upstream checks)  ││
                    │  └──────────────────────────────┘│
                    └─────────────────────────────────┘
```

## Service Configuration

Services are registered in `src/config/services.ts`:

```typescript
{
  name: 'users',
  prefix: '/api/users',
  upstreams: ['http://localhost:4001', 'http://localhost:4002'],
  authRequired: true,
  rateLimit: 100,               // requests per window
  rateLimitWindow: 60_000,      // 1 minute window
  stripPrefix: true,
  healthCheckPath: '/health',
  circuitBreakerThreshold: 5,   // failures before opening
  circuitBreakerTimeout: 30_000, // ms before half-open
  enabled: true,
}
```

## Management Endpoints

| Endpoint | Description |
|----------|-------------|
| `GET /` | Gateway info |
| `GET /gateway/health` | Health check |
| `GET /gateway/status` | Full status (services, health, circuit breakers) |
| `GET /gateway/services` | List registered services |

## Rate Limiting

Rate limit headers are included in every response:

```
X-RateLimit-Limit: 100
X-RateLimit-Remaining: 95
X-RateLimit-Reset: 1709654400
```

When exceeded, returns `429 Too Many Requests` with `Retry-After` header.

## Circuit Breaker States

| State | Description |
|-------|-------------|
| **Closed** | Normal operation. Failures are counted. |
| **Open** | Failures exceeded threshold. Requests are rejected immediately. |
| **Half-Open** | After timeout, one test request is allowed. Success closes; failure reopens. |

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `3000` | Gateway port |
| `JWT_SECRET` | `change-me-in-production` | JWT verification secret |
| `NODE_ENV` | `development` | Environment mode |

## License

MIT
