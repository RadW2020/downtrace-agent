# ADR 0004 — Protocolo v0: agregados por intervalo en JSON, con esquema como fuente única

Estado: aceptado; su consecuencia sobre ajustar ambos lados en el mismo PR está **superada por el ADR 0008** · Fecha: 2026-09-04 · Alcance: público

## Contexto

El agente y el cloud viven en lenguajes distintos (TypeScript y Go) y el protocolo va a cambiar con frecuencia en esta fase. El producto exige que el agente envíe poco (invariante: "conserva la evidencia relevante, no toda la telemetría"), que nada del agente bloquee una request (invariante 1), que la memoria esté acotada (invariantes 3 y 4) y que la detección pueda hacerse **a nivel de flota**, sumando lo que envían muchas instancias.

## Decisión

- **Agregados por intervalo de 10 s y por ruta**, no requests individuales: conteo, errores, clases de status y un **histograma de latencia con 35 buckets fijos** (límites log-lineales de 0,5 ms a 60 s, definidos una sola vez en el esquema). Los histogramas de buckets fijos se suman entre instancias, lo que permite percentiles de flota en el cloud; los percentiles precalculados no se pueden combinar.
- **JSON sobre HTTPS**, `POST /v0/aggregates` con `Authorization: Bearer <token>`; respuestas 202/400/401. Sin compresión ni binario por ahora: el payload es de pocos KB por intervalo.
- **JSON Schema 2020-12 como fuente única del contrato**, en `packages/protocol/schema/v0/`, con fixtures válidas e inválidas. Los tipos de TypeScript y Go se **generan** desde el esquema (`make gen`) y CI falla si difieren de lo commiteado. Los dos lados validan las mismas fixtures (`ajv` en TS, `santhosh-tekuri/jsonschema` en Go).
- **Cola acotada en el agente**: como máximo 6 intervalos pendientes; si el cloud no responde se conservan y se reintentan con el siguiente ciclo; si la cola se llena se descarta el más antiguo. Nunca hay reintento en el camino de una request.
- **Rutas normalizadas en el agente**: plantilla del framework cuando existe (`/products/:id`), heurística sobre el path si no; tope de 500 rutas por intervalo y resto en `(other)`.
- **Observación por `diagnostics_channel`** (`http.server.request.start` / `http.server.response.finish`), sin parchear ninguna función de la aplicación.

## Alternativas descartadas

- **OTLP / OpenTelemetry como protocolo**: pensado para traces y métricas genéricas, con SDKs pesados y un modelo de datos mucho más amplio de lo que necesitamos. El producto no compite con OpenTelemetry (`product.md`); podrá usarse internamente en el agente para instrumentar, pero no como formato de ingestión.
- **Protobuf / formato binario**: menor tamaño, pero añade toolchain en ambos lados y opacidad para el usuario que quiere ver qué sale de su servidor (restricción de transparencia). JSON con esquema es inspeccionable; la compresión puede añadirse en transporte más adelante.
- **Histogramas exponenciales (OTel) o t-digest**: más precisos por byte, pero más complejos de implementar y comparar en dos lenguajes. Los buckets fijos bastan para detectar cambios del orden que importa (un p95 de 350 → 980 ms) y son triviales de sumar.
- **Enviar cada request**: contradice el producto y el presupuesto de datos por proyecto.
- **Tipos escritos a mano en cada lado**: es exactamente el drift que el invariante 9 prohíbe.

## Consecuencias

- Cualquier cambio del protocolo es: editar el esquema, `make gen`, ajustar ambos lados en el mismo PR (ADR 0001). — **Superado por el ADR 0008**: el cloud va primero, en su propio tiquet, y el agente en uno
  posterior; nunca en el mismo PR ni en la misma publicación.
- La precisión de percentiles en el cloud está limitada por el ancho de bucket (≈ 25–50 % por decada); suficiente para regresiones, insuficiente para SLOs finos. Aceptado.
- El agente ve todos los servidores HTTP del proceso (p. ej. el proveedor simulado de la app de referencia aparece como rutas propias). Distinguir servidores es trabajo futuro.
- El primer intervalo tras arrancar y el último antes de parar pueden perderse si el cloud no responde a tiempo; se acepta a cambio de no retener el proceso.
