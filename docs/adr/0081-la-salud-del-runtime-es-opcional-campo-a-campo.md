# ADR 0081 — La salud del runtime es opcional campo a campo, y una ausencia no es un cero

Estado: aceptado · Fecha: 2026-09-10 · Alcance: público

## Contexto (gh-285)

`product.md:251`, fila de runtime: «Node.js | Go como segundo runtime; **el protocolo es independiente del
lenguaje**». Casi lo era. `agent.runtime` es un enum de dos y nada más presupone el lenguaje, salvo
`RuntimeHealth` — y peor de lo que el tiquet decía: no exigía `eventLoopDelayMs`, **exigía los seis campos**.

Un runtime de Go tiene recolección de basura, montículo y conjunto residente. No tiene event loop. Con esa
restricción podía inventarse uno o no mandar ninguno de los tres que sí tiene.

Go está en la columna *Después*, así que no era urgente. Era **más barato ahora**: el esquema es lo público y
espejado, y una restricción que haya que quitar cuando ya hay clientes es una deprecación de noventa días
(ADR 0046). Mientras el único emisor es nuestro, no cuesta nada.

## Decisión

**1. Todos los campos opcionales, y al menos uno.** Cada runtime manda lo que tiene. La alternativa —campos
comunes más un bloque por runtime— es más ordenada y obliga a decidir hoy qué es «común» sin tener el segundo
runtime delante, que es como se acierta por casualidad. `minProperties: 1`, porque una salud vacía no es una
salud.

**2. Relajar `required` es aditivo y va en la 0.7.0 sin publicar.** Un emisor que manda los seis sigue
validando; lo que cambia es que ahora valida uno que manda tres. El cloud lo acepta antes de que nadie lo
mande, que es el ADR 0008.

**3. Y la consecuencia cara, que es la que valía la pena: una ausencia se guarda como ausencia.** Si un campo
puede faltar, la columna tiene que poder estar vacía. Un cero por defecto convertiría «no lo mandó» en «midió
cero», que es exactamente la confusión que el invariante 14 existe para impedir.

Eso llega hasta el final: columnas anulables en las dos tablas —la de intervalos y su consolidación horaria—,
punteros en `RuntimeHealth` y en `HistoryRuntime`, y el pliegue entre entornos que **no dobla lo que nadie
midió**: el peor de tres lecturas no puede parecer el peor de cuatro, una de ellas un cero que nadie tomó.

Y en la interfaz: una celda sin lectura dice **«not measured»** con su motivo al pasar por encima, no un
`0.0 ms`. Un entorno que no reportó event loop ordena **después** de todos los que sí — no es «cero de
retraso», es un runtime sin event loop que retrasar.

**4. Lo que era un fixture inválido pasa a ser el caso normal.** `runtime-missing-rss.json` existía porque el
esquema exigía `rssMb`; ahora una salud parcial es lo que manda un runtime que no es Node, así que se
convierte en `runtime-without-an-event-loop.json` entre los válidos. Su sitio en los inválidos lo ocupa la
regla nueva: `runtime-with-nothing-in-it.json`.

## Alternativas

**Campos comunes más un bloque por runtime.** Arriba, decisión 1.

**Relajar solo `eventLoopDelayMs`.** Es lo que el tiquet proponía y se queda corto: con los otros cinco
obligatorios, un runtime que mide GC y heap y no cuenta requests en vuelo sigue sin poder mandar nada.

**Guardar los ausentes como cero y no tocar las columnas.** Es la mitad del trabajo y convierte el arreglo en
una mentira: el esquema diría que el campo es opcional y el almacén diría que midió cero.

**Esperar a que exista un runtime de Go.** Entonces la restricción ya tendría clientes y quitarla sería una
deprecación.

## Consecuencias

- Protocolo **0.7.0** otra vez, la misma minor sin publicar. Los tipos generados pasan a punteros en los dos
  lenguajes, que es la señal de que la ausencia existe.
- `store.Measured` y `store.Reported` son los dos ayudantes que hacen legible el resto: uno construye una
  lectura, el otro la lee cuando quien llama ya decidió qué significa que falte. Cualquier cosa que se enseñe
  a una persona usa el puntero, o enseñará un cero donde no se midió nada.
- Ningún compromiso con letra sale de la deuda. Lo que sale es que el protocolo deja de ser de Node.
