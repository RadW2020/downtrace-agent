# ADR 0008 — Evolución del protocolo: campos opcionales, versión menor, cloud primero

Estado: aceptado · Fecha: 2026-09-05 · Alcance: público

## Contexto

El protocolo v0 (ADR 0004) es un JSON Schema 2020-12 que sirve de fuente única: `make gen` produce los tipos de TypeScript y de Go, y CI falla si hay drift. El cloud valida cada lote contra ese mismo esquema y responde 400 a lo que no encaje, con `additionalProperties: false` en el endpoint. Eso significa que **un campo nuevo rompe a los agentes que ya están instalados** si se despliega en el orden equivocado: el agente lo enviaría y el cloud lo rechazaría, o el agente diría una versión que el cloud no conoce. Con `@downtrace/agent` publicado en npm, quién actualiza el agente es el operador de cada backend, no nosotros. La caja negra (`docs/product.md`) va a añadir campos durante meses; hace falta una regla, no una decisión por campo.

## Decisión

- **Solo se añade, y lo que se añade es opcional.** Un agente que no emite el campo produce un lote válido antes y después del cambio.
- **Cada adición sube la versión menor** de `PROTOCOL_VERSION`. El esquema sigue en `v0/` y el endpoint sigue siendo `POST /v0/aggregates`. El campo `protocol` del lote **no es un `const`, sino un `enum`** con todas las versiones menores publicadas de v0: el cloud acepta cualquier lote que alguna versión de v0 haya emitido, y nunca deja de aceptar una que ya publicó.
- **Cloud primero.** El esquema y el cloud que lo acepta se despliegan antes de que ningún agente emita el campo: un tiquet para protocolo y cloud, otro posterior para el agente, nunca en el mismo PR ni en la misma publicación.
- **`additionalProperties: false` se mantiene.** Un agente que emite un campo que el cloud no conoce está roto, o adelantado, y recibe 400 en la puerta en vez de perder datos en silencio.
- **Quitar o renombrar un campo, cambiar su tipo o mover los límites de un histograma es versión mayor**: `v1/`, ruta nueva y ADR nuevo. Los límites se declaran como anotaciones `x-…` del esquema (`x-latency-boundaries-ms`, `x-calls-per-request-boundaries`), de modo que forman parte del contrato generado y cualquier cambio aparece como drift en CI.

## Alternativas descartadas

- **`additionalProperties: true`**: los agentes adelantados no romperían, pero un campo mal escrito se perdería en silencio, que es peor que un 400 en un producto cuya promesa es la evidencia.
- **Una ruta nueva por cada cambio incompatible** (`v1`, `v2`…) desde el principio: obliga al cloud a mantener varios validadores y almacenes en paralelo antes de tener un solo cliente externo.
- **Protobuf o similar**: resuelve la compatibilidad por construcción, a cambio de una cadena de compilación en dos lenguajes y de perder la legibilidad de un lote como JSON, que hoy es lo que hace depurable la ingesta.

## Consecuencias

- El primer campo bajo esta regla es `postgres` en el endpoint (queries por request, 8 buckets fijos, suma y máximo): protocolo 0.2.0, con el cloud aceptándolo antes de que el agente lo emita.
- La lista de versiones aceptadas crece con cada minor. Cuando sea larga, será señal de que toca un v1, no de que la regla falle.
- El cloud debe desplegarse antes que cualquier publicación del agente que use el campo nuevo. Como el despliegue es automático en push a `main` y la publicación en npm ocurre al fusionar el PR de versiones, el orden natural de los tiquets ya lo garantiza.
