# bench

Generador de carga determinista y benchmark de overhead del agente sobre la app de referencia. Es la forma ejecutable del invariante 3: el agente añade < 1 ms en p99, < 3 puntos de CPU y < 64 MiB de RSS. Sin dependencias.

## Uso

```sh
make bench                                  # rondas 3, 200 rps, 5 s calentamiento + 20 s medición
make bench BENCH_ARGS="--warmup 3 --measure 12"
pnpm --filter @downtrace/bench run load --url http://127.0.0.1:4000 --rps 100 --duration 10 --seed 1
```

Necesita Postgres y Redis (`make dev` o `DATABASE_URL`/`REDIS_URL`); la app de referencia la arranca el propio harness en procesos hijos con puertos aleatorios.

## Cómo mide

- **Bucle abierto**: las requests salen a tasa fija con independencia de lo que tarde el servidor, y la latencia se mide desde el instante *programado* de envío. Un servidor que se retrasa aparece como cola, no se esconde tras un cliente más lento.
- **Mismo tráfico**: la secuencia de endpoints e ids sale de una semilla; ambas variantes reciben exactamente las mismas requests.
- **Rondas alternas** B/A/B/A/B/A, cada una en un proceso nuevo, para que el ruido de la máquina se reparta entre variantes. Se comparan **medianas**.
- **Veredicto** por métrica: `ok` si Δ ≤ presupuesto; `fail` si Δ > presupuesto y Δ > ruido (ruido = máx − mín entre rondas baseline); `inconclusive` si Δ > presupuesto pero ≤ ruido — la máquina no puede resolver el presupuesto. `fail` → exit 1; lo demás → exit 0 (`inconclusive` avisa).
- **Informe**: `bench-report.json` y tabla Markdown por stdout; se añade a `$GITHUB_STEP_SUMMARY` en CI.

El presupuesto vive en `src/budget.ts`. `fixtures/slow-agent.ts` es un agente falso que añade 5 ms por request: prueba que el benchmark sabe fallar.
