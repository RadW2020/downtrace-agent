# ADR 0114 — Un test que mide no corre en CI, aunque se llame test

Estado: aceptado · Fecha: 2026-09-11 · Extiende el ADR 0032 · Alcance: público

## Contexto

El ADR 0032 sacó el benchmark del pipeline porque en esa máquina no se puede medir: los dos runners viven
en la misma VM con el mismo peso de CPU, así que el bench «estaba midiendo a los vecinos». Dejó dentro
sus **tests de integración**, que miden lo mismo en la misma máquina.

Dos fallos en tres runs seguidos, cada uno por un motivo distinto y ninguno por el código: una ronda
disparada a 1882 ms de p99 (run 34531684366) y el ritmo de carga desviándose un 20,2 % de su objetivo con
un tope del 10 % (run 34592752939). El coste no es solo el rojo: es que el rojo deja de significar algo y
la cola no drena, que es literalmente lo que el ADR 0032 describió.

## Decisión

**La línea no es rápido o lento, ni unitario o de integración: es de qué habla la aserción.**

- Una aserción sobre **qué decide el código** —un agente que no entrega falla con su motivo, un baseline
  que nunca se limpia da `inconclusive` con lo que dijo la app, el informe tiene la forma que tiene— vale
  igual en una máquina tranquila y en una cargada. Se queda en CI.
- Una aserción sobre **una medida** —±10 % del ritmo pedido, que un retraso de 200 ms se detecte, que un
  calentamiento dure entre seis y diez segundos— habla de la máquina tanto como del código. Sale de CI y
  corre donde el número significa algo: `make bench-measure`, en las condiciones del benchmark.

Se separan por el nombre del fichero, `*.measure.test.ts`, porque el mecanismo que decide qué se recoge
ya existe y es ese.

**No se relaja ningún tope.** Un ±30 % que pasa siempre no comprueba nada; el ADR 0032 ya dijo que un
número cómodo y falso es peor que ninguno. Los tests se mudan enteros, con sus cifras.

**El fichero que tenía de las dos clases se parte.** El del arranque frío comprobaba la puerta de
calentamiento —comportamiento— y la duración de la ronda que produce —medida—. Partirlo cuesta un fichero
más y evita la única alternativa, que era elegir cuál de las dos comprobaciones se pierde.

## Alternativas

**Marcar los que miden `continue-on-error`.** Es la decoración que el ADR 0032 ya descartó: consagra el
rojo que se ignora.

**Ampliar los márgenes hasta que pasen en una máquina cargada.** Convierte la comprobación en una
tautología y, peor, deja creer que sigue comprobando.

**Aislar los runners con `AllowedCPUs`.** Sigue siendo la solución correcta y sigue descartada por
decisión del humano (ADR 0032). Si algún día se toma, estos tests pueden volver.

**Reintentar el job.** Lo hice dos veces hoy antes de escribir esto. Funciona y enseña a repetir hasta que
salga verde, que es la costumbre que hace inútil un pipeline.

## Consecuencias

- `make test-integration` —y por tanto CI— deja de contener aserciones sobre cuánto tardó algo.
- `make bench-measure` los ejecuta, y el `README.md` del bench dice cuándo vale su número, que es lo mismo
  que ya decía del benchmark.
- Lo que se pierde es real y conviene decirlo: **nadie comprueba automáticamente que el bench siga
  detectando un retraso de 200 ms.** Es el mismo precio que el ADR 0032 aceptó para el veredicto, y por la
  misma razón: entre una comprobación que da un resultado distinto cada vez y ninguna, ninguna es más
  honesta.
- La regla vale para lo que venga: si un test nuevo afirma una duración o un ritmo, su sitio es
  `bench-measure`, no CI.
