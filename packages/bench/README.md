# bench

Generador de carga determinista y benchmark de overhead del agente sobre la app de referencia. Es la forma ejecutable del invariante 3: el agente añade < 1 ms en p99, < 3 puntos de CPU y < 64 MiB de RSS. Sin dependencias.

## Uso

```sh
make bench                                  # rondas 3, 200 rps, 3 s limpios de calentamiento + 20 s medición
make bench BENCH_ARGS="--warmup 3 --warmup-max 30 --measure 12"
pnpm --filter @downtrace/bench run load --url http://127.0.0.1:4000 --rps 100 --duration 10 --seed 1
```

Necesita `DATABASE_URL` y `REDIS_URL` **exportadas**: el harness las exige por nombre y no lee ningún fichero de entorno, porque dos números medidos desde arranques distintos no se pueden restar (ADR 0023). Si tu Postgres no está en el puerto de siempre: `set -a; . packages/reference-app/.env; set +a` antes de `make bench`, o `make dev`. La app de referencia la arranca el propio harness en procesos hijos con puertos aleatorios.

### Opciones

`bench` (todas opcionales; `make bench BENCH_ARGS="…"`):

| Bandera | Defecto | Qué es |
|---|---|---|
| `--rounds` | 3 | Rondas B/A; cada una arranca la app en un proceso nuevo |
| `--rps` | 200 | Tasa fija del bucle abierto |
| `--measure` | 20 | Segundos medidos por ronda |
| `--warmup` | 3 | Segundos limpios consecutivos antes de medir |
| `--warmup-max` | 30 | Tope de calentamiento; si la app no llega a estar limpia, el bench termina |
| `--seed` | 42 | Semilla del tráfico, la misma para ambas variantes |
| `--agent` | `packages/agent/src/register.ts` | Módulo que se carga con `--import` en la variante con agente (p. ej. `fixtures/slow-agent.ts`) |
| `--out` | `bench-report.json` | Ruta del informe JSON |

La app se arranca con `PORT=0 PROVIDER_PORT=0 ADMIN_ENABLED=1 REGRESSIONS=""` y hereda el resto del entorno (`DATABASE_URL`, `REDIS_URL`); la variante con agente recibe además `DOWNTRACE_TOKEN=bench` y `DOWNTRACE_URL` hacia un sumidero local que cuenta los lotes.

`load` (`pnpm --filter @downtrace/bench run load …`): `--url` (`http://127.0.0.1:4000`), `--rps` (200), `--duration` (10), `--seed` (42) y `--json` para el informe completo en vez de la tabla. Sale con 1 si alguna request falló.

## Cuándo vale su número

**El benchmark no corre en CI** (ADR 0032). Se lanza a mano, y su número solo vale si se lanza bien:

- **La máquina para él solo.** Es una medida comparativa: el baseline y la variante con agente tienen que ver la
  misma máquina. Cualquier otra cosa que consuma CPU durante los veinte minutos —otro build, un contenedor
  pesado, otra pestaña compilando— se reparte entre las rondas de forma desigual y sale como si fuera el agente.
  Así se descubrió: midiendo en una VM donde corría el resto de CI, las siete peores esperas de conexión de una
  tirada cayeron dentro de un job del runner vecino (gh-200).
- **Contra un Postgres que no escriba a ráfagas.** El benchmark no es dueño de la base de datos —mide contra el `DATABASE_URL` que se le dé (ADR 0023)— y Postgres decide por su cuenta cuándo bajar páginas a disco: una tirada real lo vio escribir **26 segundos seguidos** dentro de una ventana de sesenta. El `docker-compose.yml` del repositorio ya reparte esa escritura (`checkpoint_completion_target=0.9`, `checkpoint_timeout=15min`, `max_wal_size=2GB`); si mides contra otro, ponle algo equivalente. Y mires contra el que mires, **la tabla dice cuántos checkpoints hubo en cada ronda y cuánto escribieron**, y un par cuyas mitades vieron cosas muy distintas sale `inconclusive`.
- **En la arquitectura donde se despliega.** El ADR 0020 midió que las cifras de x86 nunca verificaron el
  presupuesto: su ruido era de 3,998 ms contra un presupuesto de 1 ms. Un verde cómodo y falso.
- **Leyendo el informe, no solo el veredicto.** La tabla por ronda dice la CPU ajena que vio cada una y la peor
  espera de conexión con su hora. Si esas dos columnas se mueven entre las dos mitades de un par, ese par no es
  una comparación, y el veredicto lo dirá.

Y una limitación que conviene saber de antemano: el p99 de la propia aplicación de referencia es de unos 24 ms y
se mueve varios milisegundos entre rondas, así que la línea de 1 ms del invariante 3 está por debajo de lo que
este montaje resuelve. La CPU, con 3 puntos de presupuesto, sí es medible.

## Cómo mide

- **Bucle abierto**: las requests salen a tasa fija con independencia de lo que tarde el servidor, y la latencia se mide desde el instante *programado* de envío. Un servidor que se retrasa aparece como cola, no se esconde tras un cliente más lento.
- **Mismo tráfico**: la secuencia de endpoints e ids sale de una semilla; ambas variantes reciben exactamente las mismas requests.
- **Rondas alternas** B/A/B/A/B/A, cada una en un proceso nuevo, para que el ruido de la máquina se reparta entre variantes.
- **Calentamiento que termina limpio**: cada ronda recibe la carga un segundo por rodaja hasta encadenar `--warmup` segundos sin ninguna request fallida (3 por defecto), con tope `--warmup-max` (30). Una base de datos fría se espera, no se mide. Si la app no llega a estar limpia, el bench termina: `inconclusive` si era la ronda baseline, `fail` si era la del agente, y el motivo incluye las primeras líneas de error que la propia app escribió en stderr. La app de referencia simula ese arranque frío con `STARTUP_FAILURE_MS`.
- **Latencia**: p99 sobre **todas las muestras agrupadas** de cada variante (5 × 2400 → ~120 valores deciden el p99). El **ruido** es el mayor de dos estimaciones (ADR 0010): el de mitades (barajar el baseline con semilla, partir en dos, |p99(A) − p99(B)|, máximo de 20 repeticiones), que mide la variabilidad de muestreo, y la **dispersión entre rondas** del baseline (máx − mín de sus p99), que mide la deriva de la máquina; el informe indica cuál mandó. Además, un `fail` de latencia exige **corroboración**: la mayoría de las rondas del agente deben mostrar al menos la mitad de la diferencia agrupada, para que un parón aislado no tumbe el veredicto. **CPU y RSS**: mediana por ronda y ruido máx − mín.
- **Contra qué se midió**: cada ronda lee la CPU de **toda la máquina** durante su ventana y le resta la de todo lo que el benchmark ejecuta —la aplicación medida y el propio proceso, que lleva el generador de carga y el sumidero—; lo que queda es la **CPU ajena**, en la misma unidad que `cpuPct` (100 = un núcleo). Las rondas se alternan para que cada par vea la misma máquina, así que lo que invalida una comparación no es que hubiera vecinos —en una máquina compartida nunca son cero— sino que hubiera **vecinos distintos en cada mitad del par**: por encima de veinte puntos de diferencia, esa métrica sale `inconclusive` nombrando la ronda (ADR 0031). Nunca convierte un `fail` en `inconclusive`, y donde la CPU del host no se puede leer informa «?» sin degradar nada: no saber no es medir tranquilidad.
- **Veredicto** por métrica: `ok` si Δ ≤ presupuesto; `fail` si **Δ − presupuesto > ruido**; `inconclusive` si Δ > presupuesto pero el exceso no supera el ruido — la máquina no puede resolver el presupuesto. Lo que tiene que superar al ruido es el **margen**, no Δ (ADR 0030): comparar Δ con el ruido responde a «¿existe el sobrecoste?», que no es lo que pregunta un presupuesto, y para la CPU se cumplía siempre. La tabla imprime el margen en su propia columna, porque es el número del que depende el resultado. `fail` → exit 1; lo demás → exit 0 (`inconclusive` avisa). Los **errores de request** mandan: en rondas del agente → `fail`; solo en baseline → `inconclusive` (nunca `pass` con datos rotos). El informe desglosa los errores por código (`502×3, timeout×86`).
- **Informe**: `bench-report.json` y tabla Markdown por stdout. Ya no va a `$GITHUB_STEP_SUMMARY`: desde el ADR 0032 esto no corre en CI.

### Qué cuesta cada observador

`make bench-instruments` mide el coste de cada observador **por separado**, ejecutando el benchmark una vez por configuración: sin nada, y luego añadiendo runtime, Postgres, HTTP saliente y Redis uno a uno. La columna marginal es la diferencia con la fila anterior, es decir, lo que cuesta ese observador solo.

El presupuesto del invariante 3 es un número para el agente entero, así que cuando empiece a apretar la única pregunta útil será cuál pagar y cuál no, y eso no se responde con un total.

Cada paso compara **dos configuraciones del agente cara a cara**, no cada una contra el vacío: medir por separado y restar diferencia dos mediciones independientes y duplica la incertidumbre. La comparación es **pareada ronda a ronda**, porque las rondas se alternan en el tiempo y cada par vio la misma máquina. Que una fila sea una medición o la máquina teniendo un mal rato lo decide un **test de permutación** sobre los signos de esas diferencias —bajo la hipótesis de que el observador no cuesta nada, cuál de los dos lados salió más alto es una moneda al aire—: exacto hasta 20 rondas enumerando las 2ⁿ reasignaciones, muestreado con la semilla por encima. No supone normalidad, que las diferencias de un benchmark no tienen. El nivel es 0,05 **repartido entre las comparaciones de la tirada** (Bonferroni, ADR 0027), porque con cinco comparaciones a la vez que una salga resuelta por azar deja de ser improbable. Con cinco pasos la puerta es 0,01, y como el p más pequeño que alcanzan n diferencias es 2/2ⁿ, hacen falta **al menos ocho rondas** para que algo pueda resolverse: por eso ese es el valor por defecto, y por eso la herramienta aborta antes de gastar la máquina si le pides menos. Donde la tabla dice que no se resuelve, la máquina no ha medido ese observador y el número no significa nada. El informe imprime además **las diferencias por ronda**, para que la siguiente duda se resuelva releyendo y no midiendo.

**Ninguna cifra publicada de este reparto es citable.** Las tiradas anteriores al ADR 0027 usaban una puerta que no aguantaba sus propias comparaciones, y rehaciendo la aritmética sobre ellas no se resuelve ninguna fila (gh-187). Lo que sí está medido, en un banco controlado y no aquí, es que el agente sin ningún observador cuesta unos 2,4 µs de CPU por request —el 1,6 % del presupuesto a 200 rps— (gh-171). El reparto por observador vuelve a tener cifras cuando se ejecute bajo la puerta nueva en una máquina tranquila.

No corre en CI: es una ejecución completa del benchmark por instrumento, y es una herramienta para decidir, no un guardarraíl.

El presupuesto vive en `src/budget.ts`. `fixtures/slow-agent.ts` es un agente falso que retrasa 200 ms una de cada 50 requests (una regresión de cola, la que vigila el p99): prueba que el benchmark sabe fallar también en máquinas ruidosas.
