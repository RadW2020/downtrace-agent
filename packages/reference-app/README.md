# reference-app

Backend Node de referencia con la forma de los backends del ICP: Express 5, PostgreSQL (`pg`), Redis (`ioredis`) y un proveedor externo simulado al que se hacen llamadas HTTP reales. Sus regresiones se activan y desactivan a voluntad y expone su propia verdad —qué hizo cada request— para que benchmarks, tests y evals tengan contra qué comparar. No incluye ni depende del agente.

## Arrancar

```sh
make dev            # Postgres 17 + Redis 8 en Docker y la app con recarga en :4000 (proveedor en :4001)
make test-integration
```

Configuración por entorno en `.env.example`; los valores por defecto coinciden con `docker-compose.yml`. Lo que el `.env.example` no cuenta:

- `PORT=0` y `PROVIDER_PORT=0` eligen un puerto libre (así arranca la app el harness de bench); la app escucha solo en `127.0.0.1`.
- `STARTUP_FAILURE_MS=<ms>` simula una base de datos fría: el tráfico de producto recibe 503 (`ColdStartError`) durante esos ms desde la primera request; `/__admin/*` no se ve afectado. 0 desactiva.
- Un nombre desconocido en `REGRESSIONS` aborta el arranque. Un entero mal formado en cualquier variable cae al valor por defecto sin aviso.
- Cada 5xx deja una línea JSON en stderr (`level`, `status`, `method`, `path`, `error`, `message`); el bench la copia en el motivo de su veredicto.

## Endpoints

| Ruta | Qué hace | Perfil normal |
|---|---|---|
| `GET /healthz` | `{status, version}` (`APP_VERSION`) | — |
| `GET /products` | lista de productos | 1 query |
| `GET /products/:id` | un producto | 1 query |
| `GET /me` | usuario de `x-user-id` (por defecto 1), cacheado en Redis 300 s | miss: 1 query + 2 Redis · hit: 1 Redis |
| `POST /checkout` | `{userId, items:[{productId, quantity}], coupon?}` → pedido pagado | **12 queries, 2 llamadas al proveedor, 3 Redis** |

## Regresiones

Se activan al arrancar con `REGRESSIONS=n_plus_one,slow_dependency` o en caliente con `PUT /__admin/regressions`:

```json
{ "slow_dependency": { "enabled": true, "params": { "delayMs": 300 } } }
```

| Nombre | Efecto | Parámetros (defecto) |
|---|---|---|
| `n_plus_one` | checkout hace 4 queries por línea en vez de 3 para todo el pedido | — |
| `slow_dependency` | el proveedor tarda `delayMs` más | `delayMs` (3000) |
| `aggressive_retries` | llamadas al proveedor con timeout corto y reintentos sin backoff | `timeoutMs` (500), `retries` (3) |
| `pool_leak` | una fracción de checkouts no devuelve su conexión al pool | `rate` (0.2) |
| `new_error` | una fracción de `GET /products/:id` lanza `InventoryMismatchError` | `rate` (0.1) |

Las llamadas al proveedor ocurren dentro de la transacción a propósito: es una forma habitual en producción y es lo que convierte una dependencia lenta en presión sobre el pool.

## Admin (`ADMIN_ENABLED=1`, por defecto)

- `GET`/`PUT /__admin/regressions` — estado y parámetros.
- `GET`/`PUT /__admin/provider` — `delayMs` manual y `failureRate` del proveedor.
- `GET /__admin/process` — `cpu` (`process.cpuUsage()`), `memory` (`process.memoryUsage()`), `eventLoopUtilization`, `uptimeMs`; lo muestrea el benchmark de overhead.
- `GET /__admin/stats` — por endpoint: requests, status por clase, `sqlQueries`, `providerCalls`, `providerRetries`, `redisOps`, `poolWaitMs`, `errors` por tipo, `totalDurationMs`.
- `POST /__admin/stats/reset`.

El tráfico a `/__admin/*` no se contabiliza. Con `ADMIN_ENABLED=0` estas rutas no existen (404).
