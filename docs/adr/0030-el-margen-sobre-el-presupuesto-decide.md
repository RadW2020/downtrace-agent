# ADR 0030 — El veredicto lo decide el margen sobre el presupuesto, no Δ

Estado: aceptado · Fecha: 2026-09-08 · Supera la condición de `fail` de los ADR 0007 y 0010 · Alcance: público

## Contexto

La regla del veredicto decía: `fail` cuando «Δ > presupuesto **y Δ > ruido**», e `inconclusive` cuando «Δ >
presupuesto pero Δ ≤ ruido».

La segunda comparación estaba mal. Δ es el sobrecoste absoluto y el ruido es la incertidumbre sobre él, así que
preguntar si Δ supera al ruido responde a **«¿existe el sobrecoste?»**. Esa no es la pregunta. El presupuesto
pregunta **«¿se pasa?»**, y eso se responde comparando el ruido con el margen por encima del presupuesto.

El fallo estaba desde que se escribió la regla y solo se activa cuando Δ roza la línea, que es exactamente cuando
el veredicto importa. Mientras el agente costó 2,44–2,72 pp de un presupuesto de 3, la primera condición decidía
y la segunda nunca llegaba a usarse. En la tirada del 2026-09-08:

```
cpuPct | baseline 24.238 | agente 27.264 | Δ +3.026 | ruido 0.840 | ≤ 3 | ❌ fail
```

`Δ > ruido` es 3,026 > 0,840, que se cumple siempre: el agente cuesta unos 3 pp y el ruido menos de 1, así que la
regla no podía decir otra cosa. Pero el margen era **0,026 pp con un ruido de 0,840**: esa máquina no distingue
3,026 de 2,9 ni de 3,15. Se afirmó un `fail` que la medida no sostiene.

Con la latencia las dos reglas casi coincidían —presupuesto 1 ms y Δ del orden de 1 ms— y por eso tampoco se vio
allí, pero el error es el mismo y estaba en las dos implementaciones.

## Decisión

**Lo que tiene que superar al ruido es el exceso sobre el presupuesto, no Δ.**

```
ok            Δ ≤ presupuesto
fail          Δ − presupuesto > ruido
inconclusive  Δ > presupuesto pero el exceso no supera el ruido
```

- En la latencia agrupada, la comprobación va **antes** de la regla de corroboración del ADR 0010, que se conserva
  entera: un margen que no se resuelve ni siquiera llega a preguntarse si las rondas lo corroboran.
- **El informe imprime el margen** en su propia columna. Es el número del que depende el veredicto y no aparecía
  en ningún sitio; quien leía la tabla no tenía cómo saber por qué el resultado era el que era.
- Un empate no basta: el exceso tiene que ser **mayor** que el ruido, no igual.

## Alternativas

**Dejarlo y bajar el ruido.** Es lo que hay que hacer de todas formas (gh-139, gh-177), pero no arregla la regla:
con menos ruido, `Δ > ruido` seguiría cumpliéndose siempre para la CPU, y el veredicto seguiría sin depender de la
pregunta que dice responder.

**Comparar Δ con presupuesto + ruido**, que es la misma aritmética escrita al revés. Descartada solo por
legibilidad: nombrar el margen y compararlo con el ruido dice lo que se está decidiendo; sumar el ruido al
presupuesto parece que ablanda el presupuesto, y no es eso lo que ocurre.

**Un intervalo de confianza en condiciones** en vez de «ruido» como una sola cifra. Es lo correcto a largo plazo y
está emparentado con el gh-187, pero cambia la estimación además de la comparación, y aquí lo que estaba roto era
la comparación. Un cambio cada vez.

## Consecuencias

- **El banco actual ya no puede verificar el invariante 3 en CPU.** Con el agente a ~3 pp de un presupuesto de 3 y
  un ruido de 0,84, la respuesta honesta es `inconclusive`, y ahora eso es lo que dirá en vez de fingir un `ok` o
  un `fail` según de qué lado caiga la mediana. Es peor de leer y mejor de creer. Volver a poder afirmarlo exige
  menos ruido o menos coste: gh-139, gh-177 y gh-187.
- La regla nueva **no** puede convertir el guardarraíl en un adorno, y hay un test que lo fija: un exceso de 3 pp
  contra 0,42 de ruido sigue siendo `fail`.
- Este cambio afecta a un PR que estaba en rojo por la regla vieja (gh-186 / PR #189). Se decidió y se fusionó por
  separado y antes, para que corregir la regla no fuese la manera de aprobar un PR propio.
