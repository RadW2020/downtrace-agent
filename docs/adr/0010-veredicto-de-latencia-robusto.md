# ADR 0010 — Veredicto de latencia: ruido entre rondas y corroboración

Estado: aceptado · Fecha: 2026-09-05 · Alcance: público

## Contexto

El ADR 0007 comparaba el p99 de todas las muestras agrupadas y estimaba el ruido por mitades del pool baseline. En un solo día, con el agente sin cambios, eso produjo tres `fail` falsos:

- Run 33967120965 (`integration`, 3 × 6 s × 100 rps): una ronda del agente con p99 191 ms frente a 15–17 ms en las otras cinco. Un parón de ~200 ms encola unas 20 requests, y el p99 agrupado de 1 800 muestras lo deciden 18 valores: una ronda lo arrastra sola.
- Run 33967738239 (gate `bench`, 5 × 12 s × 200 rps): Δ +1,278 ms con ruido por mitades 1,181. Pero los p99 por ronda del baseline (18,5 / 19,6 / 20,2 / 19,7 / 18,3) se dispersan 1,9 ms: más que el ruido estimado.
- PR #48, tres ejecuciones de la misma rama con el mismo código: Δ +0,367, +0,128 y +2,449.

El ruido por mitades mide la variabilidad **de muestreo dentro del pool**. No mide la **deriva del runner entre rondas**, que las rondas alternas solo cancelan en parte. Y ninguna regla exigía que la diferencia se viera en más de una ronda.

## Decisión

- **Ruido de latencia = `max(ruido por mitades, máx − mín de los p99 por ronda del baseline)`.** El informe dice de cuál de los dos vino (`noiseSource`).
- **Corroboración por rondas.** Con Δ la diferencia agrupada y `Δ_i = p99(ronda i del agente) − mediana(p99 de las rondas baseline)`, una ronda corrobora si `Δ_i ≥ Δ/2`. Un `fail` en latencia exige, además de `Δ > presupuesto` y `Δ > ruido`, que corrobore la **mayoría estricta** de las rondas del agente. Si no, `inconclusive` con motivo `one round dominates the tail (k/n rounds corroborate)`.
- La regla es una **función pura** (`packages/bench/src/latency-rule.ts`) sobre Δ agrupada, ruido por mitades, p99 por ronda de cada variante y presupuesto: un run de CI se replica en un test con los números de su propio informe.
- **No cambian** el presupuesto, la carga, las rondas alternas, el pool agrupado, la regla de errores de ronda ni CPU y RSS.

## Alternativas descartadas

- **Comparar cada ronda del agente solo contra la mediana del baseline**: en el run 33967120965 las tres rondas la superan (+1,86 / +175,4 / +0,37); sin el umbral Δ/2 el `fail` habría seguido en pie.
- **Estimar el ruido también sobre el pool del agente**: mezcla la señal que se quiere medir con la medida del instrumento.
- **Repetir el bench cuando el `fail` es marginal**: eficaz y barato (solo en el caso dudoso), pero duplica el tiempo del job justo cuando el runner ya va mal. Queda anotado por si esta regla no basta.
- **Subir el presupuesto o bajar la carga**: sería debilitar el guardarraíl, que es lo que estas reglas existen para evitar.

## Consecuencias

- Supera parcialmente el ADR 0007: su estimación del ruido y su condición de `fail` en latencia. Todo lo demás de aquel ADR sigue vigente.
- El bench dirá `inconclusive` más a menudo. Es la respuesta correcta cuando la máquina no puede resolver 1 ms, y sigue sin dar nunca un `pass` con datos rotos.
- La regresión de cola que vigila el presupuesto (el agente falso que retrasa 200 ms una de cada 50 requests) aparece en todas las rondas, corrobora n/n y sigue siendo `fail`, en test unitario y de integración.
- Si el `inconclusive` se vuelve la respuesta habitual, la salida es más muestras o un entorno menos ruidoso, nunca un presupuesto más laxo.
