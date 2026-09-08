# ADR 0003 — Metodología del benchmark de overhead del agente

Estado: aceptado; su parte estadística (mediana de p99 por ronda, ruido máx−mín) y el agente falso están superados por el ADR 0007, dar por comparables las rondas alternas sin fijar el estado de la base de datos lo supera el ADR 0021, y la lectura de `packages/reference-app/.env` por el harness la supera el ADR 0023 · Fecha: 2026-09-03 · Alcance: público

## Contexto

El invariante 3 (< 1 ms en p99, < 3 puntos de CPU, < 64 MiB) es la promesa central del producto y debe comprobarla una máquina en cada cambio. Medir un milisegundo en p99 es difícil: las máquinas de CI son ruidosas, dos ejecuciones idénticas nunca dan el mismo número, y un benchmark que bloquea PRs por azar acaba desactivado. A la vez, el agente aún no hace nada: hay que validar el harness y fijar la línea base antes de que exista algo que proteger.

## Decisión

- **Bucle abierto a tasa fija.** El generador emite requests según un calendario, independiente de lo que tarde el servidor, y mide la latencia desde el instante *programado* de envío. Así el trabajo es idéntico en ambas variantes y un servidor que se retrasa aparece como cola en lugar de esconderse tras un cliente más lento (sin *coordinated omission*).
- **Mismo tráfico.** La secuencia de endpoints e ids sale de un PRNG con semilla (mulberry32, propio). Ambas variantes reciben exactamente las mismas requests.
- **Rondas alternas en procesos nuevos.** Baseline y agente se alternan (B/A/B/A/B/A), cada ronda en un proceso recién arrancado con calentamiento previo, para que el ruido de la máquina se reparta. Se comparan **medianas** entre rondas.
- **Recursos desde dentro del proceso.** CPU y RSS se leen de `GET /__admin/process` de la app de referencia (`process.cpuUsage()`, `process.memoryUsage()`), muestreado al inicio, cada segundo y al final de la ventana. Es portable y no exige permisos sobre procesos ajenos.
- **Tres veredictos.** Por métrica: `ok` si Δ ≤ presupuesto; `fail` si Δ > presupuesto **y** Δ > ruido; `inconclusive` si Δ > presupuesto pero Δ ≤ ruido, donde ruido = máx − mín de la métrica entre las rondas baseline. `fail` bloquea (exit 1); `inconclusive` avisa y no bloquea. Una regresión real destaca muy por encima del ruido; un runner lento produce `inconclusive`, no falsos rojos.
- **El agente vacío es la línea base.** `@downtrace/agent/register` existe y no hace nada; el benchmark lo mide desde el día uno. Todo lo que el agente haga en adelante se mide contra ese cero.
- **El benchmark debe saber fallar.** Un agente falso que añade 5 ms por request (`fixtures/slow-agent.ts`) forma parte de la suite: si algún día el harness deja de detectarlo, CI lo dice.
- **Presupuesto en código.** Los números viven en `packages/bench/src/budget.ts`; `docs/invariants.md` apunta ahí.

## Alternativas descartadas

- **Bucle cerrado (N usuarios concurrentes)**: el trabajo realizado depende de la latencia, así que CPU y throughput dejan de ser comparables entre variantes, y sufre *coordinated omission*.
- **`autocannon`/`wrk`**: excelentes para throughput, pero no permiten fijar una mezcla ponderada con la misma secuencia exacta en ambas variantes sin añadir dependencias y un envoltorio equivalente al que ya se necesita.
- **Medir latencia dentro del servidor**: excluye la cola de conexión y el event loop, que es justo donde un agente mal hecho hace daño.
- **Veredicto binario**: en máquinas ruidosas produce falsos rojos que acaban con el benchmark ignorado o desactivado.
- **Una sola pasada de cada variante**: sin rondas no hay estimación de ruido ni medianas; cualquier pausa de GC decide el resultado.

## Consecuencias

- Cada cambio en el agente pasa por `make bench` en CI (job `bench`), con informe en el resumen del job y `bench-report.json` como artefacto.
- Un `inconclusive` repetido en CI es información: la máquina no resuelve 1 ms en p99 con la carga actual. La respuesta es subir muestras (rps o duración) o mover el benchmark a una máquina dedicada, no relajar el presupuesto.
- La app de referencia gana `GET /__admin/process`; sigue sin depender del agente (se inyecta por ruta absoluta con `node --import`).
- El harness arranca la app como proceso hijo leyendo `packages/reference-app/.env` si existe, con las variables del entorno por encima. — **Superado por el ADR 0023**: el harness exige `DATABASE_URL` y `REDIS_URL` por nombre
  y no lee ningún fichero, porque dos números medidos desde arranques distintos no se pueden restar.
