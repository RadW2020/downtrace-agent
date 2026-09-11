# ADR 0111 — Una ronda corrobora contra el presupuesto, no contra la delta agregada

Estado: aceptado; **supera el listón de la regla de corroboración del ADR 0010** · Fecha: 2026-09-11 · Alcance: público

## Contexto

El ADR 0010 añadió la corroboración por rondas: un `fail` de latencia exige que la mayoría de las rondas
del agente vean la diferencia, porque una sola ronda con la cola larga arrastra un p99 agrupado ella
sola. El listón que puso era **relativo**: una ronda corrobora si su delta llega a la mitad de la delta
agregada.

Ese listón lo fija la peor ronda. El 2026-09-10, en el run 34531684366, el test que inyecta +200 ms al
2 % de las requests midió:

```
baseline#1 p99=31.18 | agent#1 p99=209.76 | baseline#2 p99=25.02 | agent#2 p99=1882.79
Δ agregada 1541.196, ruido 6.699 → inconclusive, «one round dominates the tail (1/2)»
```

La ronda 1 es exactamente lo inyectado: 209.76 menos la mediana de baseline, 28.1, son 181.66 ms ≈ los
~180 ms que 2 % de requests con +200 ms mueven en el p99. La ronda 2 se disparó por la máquina. Y la
delta agregada, inflada por la segunda, puso el listón en 770.6, por encima de la primera.

Es decir: las dos rondas superaban el presupuesto por tres órdenes de magnitud, la regresión estaba
medida y corroborada, y la regla la descartó **porque una ronda salió todavía peor**.

## Decisión

**Una ronda corrobora cuando su propia delta supera el presupuesto más el ruido**, que es exactamente lo
que la delta agregada tiene que superar para fallar (ADR 0030). El mismo listón, aplicado a cada ronda.

La mayoría estricta se mantiene tal cual.

## Alternativas

**Recortar la ronda atípica antes de agregar.** Descarta información medida y necesita un criterio de
«atípica» que no existe; el bench mide máquinas ruidosas a propósito.

**Bajar el listón relativo a un tercio.** Mueve el problema sin quitarlo: sigue dependiendo de la peor
ronda, y el run que lo destapó lo habría pasado por poco y el siguiente no.

**Quitar la corroboración.** Devuelve el fallo que el ADR 0010 arregló: una ronda con cola larga bastaría
para un `fail` falso.

## Consecuencias

- Lo que el ADR 0010 protegía sigue protegido, y sus dos casos siguen en los tests: una ronda de 191 ms
  entre dos tranquilas sigue siendo `inconclusive` con su motivo.
- El error simétrico —un `inconclusive` falso— deja de ocurrir por esta causa. Importa más que el otro:
  el bench existe para defender el invariante 3, y un `inconclusive` es la salida que no defiende nada.
- Los números del run que lo destapó están en un test. La regla sigue siendo una función de su entrada,
  así que un run de CI se puede replicar desde las cifras de su propio informe.
- La frecuencia observada del fallo era 1 de cada 40 runs de CI. No es lo que motiva el cambio —la
  dirección del error lo motiva—, pero explica por qué nadie lo había visto.
