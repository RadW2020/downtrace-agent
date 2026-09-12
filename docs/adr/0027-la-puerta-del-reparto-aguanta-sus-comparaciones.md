# ADR 0027 — La puerta del reparto por observador aguanta sus propias comparaciones

Estado: aceptado · Fecha: 2026-09-08 · Alcance: público

## Contexto

`make bench-instruments` compara cinco configuraciones del agente en una sola tirada para responder a qué
observador pagar cuando el presupuesto del invariante 3 se agota. Su columna `resolved?` decide si una cifra es
citable, y hasta ahora la decidía `Math.abs(mean) > 2 * stderr`.

Ese criterio falla por dos sitios a la vez, y los dos son estructurales de esta herramienta, no accidentes:

- **La constante 2 es un valor crítico asintótico.** Con las cinco rondas que trae por defecto, el valor que
  corresponde es 2,776: un intervalo un 39 % más ancho. La puerta era más permisiva justo donde menos datos había.
- **Cinco comparaciones, ninguna corrección.** El informe avisaba **en prosa** de que se espera que una resuelva
  por azar, pero la bandera —lo único que alguien lee para decidir— no lo tenía en cuenta. Cuando la prosa y la
  bandera se contradicen, gana la bandera.

No es hipotético. El reparto atribuyó +0,592 pp al agente con `DOWNTRACE_INSTRUMENT=none`; un banco controlado
midió 0,049 pp para la misma variante (gh-171). Rehacer la aritmética sobre la tabla publicada mostró que con la
puerta correcta **ninguna de las cinco filas resolvía**: no había contradicción entre bancos, había un informe
declarando medido lo que no había medido. Sobre esas cifras se había apoyado un bloqueo de trabajo (gh-139).

## Decisión

**La significación de cada fila la decide un test de permutación exacto sobre los signos de las diferencias
pareadas, con el nivel repartido entre las comparaciones de la tirada.**

- Las rondas alternan en el tiempo, así que bajo la hipótesis de que un observador no cuesta nada, **cuál de los
  dos lados salió más alto es una moneda al aire**. Enumerar las 2ⁿ reasignaciones de signo da un valor p exacto.
- Por encima de 20 diferencias se muestrea con la semilla de la tirada, y el informe dice que el p es muestreado.
- La puerta es `p < 0,05 / m`, con `m` el número de comparaciones (Bonferroni).
- **Antes de medir**, la herramienta comprueba que las rondas pedidas permiten alcanzar esa puerta: el p mínimo
  con n diferencias es `2 / 2ⁿ`. Si no, aborta y dice cuántas rondas harían falta.
- El informe imprime **las diferencias por ronda** de cada comparación.

El aviso en prosa sobre comparaciones múltiples se retira: lo que decía queda aplicado en la puerta, y un hecho
vive en un solo sitio.

## Alternativas

**La *t* de Student con el valor crítico correcto para n.** Arregla el primer defecto y, con Bonferroni, también
el segundo. Descartada porque supone normalidad de las diferencias, y las diferencias de un benchmark no la
tienen: una ronda en la que el sistema operativo decidió otra cosa produce una cola que la *t* no contempla y que
la permutación absorbe sin inmutarse. Además obliga a una tabla de valores críticos o a invertir la CDF, más
código y menos evidente que enumerar signos.

**Holm en vez de Bonferroni.** Más potente y no mucho más complejo. Descartada por ahora: con cinco comparaciones
la diferencia es pequeña, y Bonferroni se explica en una frase. Si el reparto crece a diez o quince pasos, esta
decisión merece revisarse.

**Dejar la puerta y arreglar solo la prosa.** Descartada: el problema es precisamente que nadie lee la prosa
cuando hay una columna que dice `yes`.

## Consecuencias

- **Las cinco rondas por defecto ya no sirven para cinco comparaciones**: el p mínimo alcanzable es 0,0625 y la
  puerta 0,01. La herramienta lo dice al arrancar y exige ocho rondas o más. Es una restricción real, y es la que
  siempre hubo: antes se ejecutaba igual y devolvía banderas que no significaban nada.
- **Ninguna cifra del reparto publicada hasta hoy es citable.** Ni los 0,592 pp del agente, ni los 0,795 de pg
  (gh-172), ni los 0,487 de Redis. No están en `docs/`, y no entrarán sin una tirada bajo esta puerta.
- El criterio del **veredicto del benchmark** (ADR 0007, 0010) no cambia: compara contra un presupuesto absoluto
  con regla de corroboración, que es otro problema. Este ADR no lo supera ni lo toca.
- Guardar las diferencias por ronda hace que la próxima duda cueste una lectura y no una hora de máquina. Esa
  hora ya se gastó dos veces.
