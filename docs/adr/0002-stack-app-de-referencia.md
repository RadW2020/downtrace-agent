# ADR 0002 — Stack de la app de referencia: Express 5, `pg`, `ioredis`, Node ejecutando TypeScript

Estado: aceptado · Fecha: 2026-09-03 · Alcance: público

## Contexto

La app de referencia es el objetivo del benchmark de overhead, el banco de integración del agente y el generador de fixtures para las evals. Las librerías que use son las primeras que el agente tendrá que instrumentar, así que la elección no es de gusto: debe reflejar lo que hay en producción en el ICP (`product.md`): SaaS pequeños y medianos en Node sin APM.

## Decisión

- **Express 5** como framework HTTP, **`pg`** para PostgreSQL e **`ioredis`** para Redis: las opciones más extendidas en el ICP.
- El proveedor externo es un **servidor HTTP real en el mismo proceso** (otro puerto), no un mock en memoria: el agente debe ver llamadas salientes reales.
- Las llamadas al proveedor ocurren **dentro de la transacción** de checkout, a propósito: es una forma habitual en producción y es lo que convierte una dependencia lenta en presión sobre el pool (el segundo ejemplo de `product.md`).
- La verdad observable (`/__admin/stats`) se implementa con **contadores propios pasados explícitamente** por request (`res.locals.ctx`), no con `AsyncLocalStorage`: es la referencia contra la que se comparará el agente, y no debe compartir su mecanismo ni sus posibles fallos de propagación.
- **Node ejecuta el TypeScript directamente** (*type stripping*, Node ≥ 22.6) sin paso de build. El tsconfig activa `erasableSyntaxOnly` y `allowImportingTsExtensions`, y los imports llevan extensión `.ts`.

## Alternativas descartadas

- **Fastify**: mejor rendimiento y diseño, pero menos frecuente en el ICP; instrumentarlo primero optimizaría para el usuario equivocado.
- **`node:http` puro**: sin framework no hay plantillas de ruta (`/products/:id`) que normalizar, que es justo uno de los problemas reales del agente.
- **node-redis** (`redis`): cliente oficial, pero `ioredis` sigue siendo el más instalado en código existente.
- **Mock del proveedor en memoria**: no genera tráfico HTTP saliente observable.
- **`tsx`/build con `tsup`** para ejecutar: dependencia y paso extra que Node ya no necesita para este paquete.

## Consecuencias

- El agente empieza por Express 5, `pg` e `ioredis`; otros frameworks y clientes se añaden después con la misma app como banco (fuera de alcance por ahora).
- El perfil normal de `POST /checkout` queda fijado en el código: 12 queries, 2 llamadas al proveedor, 3 operaciones Redis. Los tests de integración lo verifican y son la spec viva de cada regresión.
- Cualquier código que Node deba ejecutar sin build no puede usar *enums*, *namespaces* ni *parameter properties*; el typecheck lo impide.
- La app depende de Postgres y Redis reales: los tests de integración se saltan con aviso si no hay `DATABASE_URL`, y CI los ejecuta en un job propio con servicios.
