# bench

Generador de carga determinista y benchmark de overhead del agente sobre la app de referencia. Es la forma ejecutable del invariante 3: el agente añade < 1 ms en p99, < 3 puntos de CPU y < 64 MiB de RSS. Sin dependencias.

## Uso

```sh
make bench                                  # rondas 3, 200 rps, 3 s limpios de calentamiento + 20 s medición
make bench BENCH_ARGS="--warmup 3 --warmup-max 30 --measure 12"
pnpm --filter @downtrace/bench run load --url http://127.0.0.1:4000 --rps 100 --duration 10 --seed 1
```

Necesita Postgres y Redis (`make dev` o `DATABASE_URL`/`REDIS_URL`); la app de referencia la arranca el propio harness en procesos hijos con puertos aleatorios.

## Cómo mide

- **Bucle abierto**: las requests salen a tasa fija con independencia de lo que tarde el servidor, y la latencia se mide desde el instante *programado* de envío. Un servidor que se retrasa aparece como cola, no se esconde tras un cliente más lento.
- **Mismo tráfico**: la secuencia de endpoints e ids sale de una semilla; ambas variantes reciben exactamente las mismas requests.
- **Rondas alternas** B/A/B/A/B/A, cada una en un proceso nuevo, para que el ruido de la máquina se reparta entre variantes.
- **Calentamiento que termina limpio**: cada ronda recibe la carga un segundo por rodaja hasta encadenar `--warmup` segundos sin ninguna request fallida (3 por defecto), con tope `--warmup-max` (30). Una base de datos fría se espera, no se mide. Si la app no llega a estar limpia, el bench termina: `inconclusive` si era la ronda baseline, `fail` si era la del agente, y el motivo incluye las primeras líneas de error que la propia app escribió en stderr. La app de referencia simula ese arranque frío con `STARTUP_FAILURE_MS`.
- **Latencia**: p99 sobre **todas las muestras agrupadas** de cada variante (5 × 2400 → ~120 valores deciden el p99), y ruido por mitades (barajar el baseline con semilla, partir en dos, |p99(A) − p99(B)|, máximo de 20 repeticiones). **CPU y RSS**: mediana por ronda y ruido máx − mín.
- **Veredicto** por métrica: `ok` si Δ ≤ presupuesto; `fail` si Δ > presupuesto y Δ > ruido; `inconclusive` si Δ > presupuesto pero ≤ ruido — la máquina no puede resolver el presupuesto. `fail` → exit 1; lo demás → exit 0 (`inconclusive` avisa). Los **errores de request** mandan: en rondas del agente → `fail`; solo en baseline → `inconclusive` (nunca `pass` con datos rotos). El informe desglosa los errores por código (`502×3, timeout×86`).
- **Informe**: `bench-report.json` y tabla Markdown por stdout; se añade a `$GITHUB_STEP_SUMMARY` en CI.

El presupuesto vive en `src/budget.ts`. `fixtures/slow-agent.ts` es un agente falso que retrasa 200 ms una de cada 50 requests (una regresión de cola, la que vigila el p99): prueba que el benchmark sabe fallar también en máquinas ruidosas.
