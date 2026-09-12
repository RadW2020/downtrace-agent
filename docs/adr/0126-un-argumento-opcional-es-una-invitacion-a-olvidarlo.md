# ADR 0126 — Un argumento opcional es una invitación a olvidarlo

Estado: aceptado · Fecha: 2026-09-12 · Alcance: público

## Contexto

El prearmado se dio por terminado, se plegó y se publicó en `@downtrace/agent@0.8.0`. No hacía nada.

Las piezas estaban todas y cada una con su test en verde: `arm()` armaba, `observe()` escribía, `sliceFor` sabía unir la reserva con el anillo global, y había un test que lo comprobaba con una reserva escrita a mano. Lo que faltaba era el cable:

- `deliverEvidence` llamaba a `sliceFor(capture, snapshot, nameOf)`. El cuarto parámetro, `prearm`, era **opcional**, y esa llamada —la única de producción— no lo pasaba.
- `observe()` recibía `operations: []` y `dependencies: []` en cada request, tirando lo que el anillo fino acababa de guardar.
- La reserva declaraba `dependencies` en su fila y no las almacenaba, así que una captura **de una dependencia** no casaba nunca con ella.
- El comentario que acompañaba a la escritura decía «Nothing arms yet — that is gh-476». El gh-476 había entrado y armaba treinta líneas más arriba.

Es la tercera vez: el gh-398 tuvo los dos extremos del canal de control probados y el contrato entre ellos roto; el gh-371 tuvo cada pieza de la entrega del perfil en verde con dos fallos encadenados en el camino de salida.

## Decisión

**Donde dos piezas se juntan, el parámetro que las une no es opcional.** `sliceFor` exige `prearm`, y `null` es cómo se dice que no hay reserva. Un `null` explícito es una decisión que alguien tomó; un argumento ausente es una que nadie tomó.

**Lo que caza un cable cortado es el compilador.** Ningún test unitario podía ver esto, porque cada unidad estaba bien. Hacer el parámetro obligatorio convierte el fallo en un error de compilación en el único sitio donde importa: la llamada de producción.

**Un registro sin costura de inyección es un registro sin test de integración.** La reserva era el único de los cinco que no se podía inyectar, y es el único que se publicó roto. Ahora se inyecta como los demás, y hay un test que recorre el camino del agente publicando en los mismos canales de diagnóstico que un servidor real.

**Un comentario que describe un mundo que ya no existe es peor que ninguno.** El de `agent.ts` decía que nada armaba todavía, y se leyó como cierto. No hay regla automática para esto; lo que hay es que un comentario que nombra un tiquete pendiente se relee cuando ese tiquete entra.

## Alternativas descartadas

**Un guardián sobre el código fuente**, como `check-vocabulary.sh`, que exigiera que la llamada pase los cuatro argumentos. Funciona y es frágil: cambia la forma de la llamada y deja de comprobar, en silencio. El sistema de tipos ya sabe hacer esto.

**Dejarlo opcional y añadir un test que lo cubriera.** Es lo que había: había un test, y probaba el ensamblador con una reserva de fixture. El test correcto —el del camino del agente— también se ha escrito, pero por sí solo no impide que la próxima llamada nueva olvide el argumento.

**Un valor por defecto que no fuera `undefined`** —una reserva vacía— para que la llamada sin argumento hiciera algo razonable. Es lo mismo un nivel más abajo: el corte seguiría sin verse, solo que en vez de «no hay reserva» diría «la reserva está vacía», que es la mentira que el invariante 14 prohíbe.

## Consecuencias

- Todas las llamadas de `sliceFor` en los tests dicen ahora explícitamente si hay reserva. Son más ruidosas y cada una declara lo que prueba.
- La reserva ocupa 116 KiB de los 192 del presupuesto, con el anillo de dependencias contado: `bytes()` sumaba dos arrays de tres, que es un presupuesto equivocado exactamente en lo que nadie miraba (ADR 0067).
- `FineRegister.operationsAt` es público, y el `snapshot` lo usa también: un recorrido para los dos lectores, porque dos tendrían que ponerse de acuerdo sobre qué significa que el detalle se haya perdido.
- La regla se aplica a lo que venga: un parámetro que une dos subsistemas se declara obligatorio aunque su valor natural sea «nada».
