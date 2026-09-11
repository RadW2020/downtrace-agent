# ADR 0107 — Un instante se guarda absoluto; una duración se mide monótona

Estado: aceptado · Fecha: 2026-09-11 · Alcance: público

## Contexto

La instrumentación mide con `performance.now()`, que cuenta milisegundos desde que arrancó el proceso y no
salta cuando el reloj del sistema se ajusta. Es la elección correcta para **medir** y la equivocada para
**fechar**, y el registro fino guardaba con ella las dos cosas.

Lo que se rompía, concretamente:

- La evidencia de una captura convierte ese número con `new Date(...)`, así que fechaba cada request en
  1970. El esquema pide justo lo contrario: «Absolute, so requests from two instances can be read side by
  side».
- Las dos coberturas de CAP-01 comparan el instante de cada request con el inicio efectivo de la captura,
  que viene de `Date.now()`. Seis cifras contra trece: **ninguna request se contaba nunca como observada**.
  Medido en el e2e: `{ObservedRequests:0 AttachedRequests:83}` con doce requests hechas dentro de la
  ventana.

## Decisión

**Una duración se mide con el reloj monótono. Un instante se guarda en el reloj del mundo.** El registro
fino guarda `performance.timeOrigin + performance.now()`: el origen es el instante en que arrancó el
proceso, medido una vez, y sumarlo no cuesta una lectura de reloj más.

La regla, dicha entera: un número que va a compararse con algo de fuera del proceso —el inicio de una
captura, el instante de otra instancia, una fecha en el protocolo— tiene que ser absoluto. Un número que
solo se resta contra otro del mismo proceso puede ser monótono, y debe serlo.

## Alternativas

**Llamar a `Date.now()` al empezar cada request.** Una lectura de reloj más por request, en el camino que
el invariante 3 presupuesta, para obtener lo mismo que una suma.

**Convertir al enviar, restando el `performance.now()` de ese momento.** Funciona para fechar y no arregla
la comparación: el registro seguiría guardando un número que no se puede comparar con el inicio de una
captura, y ahí es donde estaba la mitad cara del fallo.

**Guardar los dos relojes por request.** Ocho bytes más por fila en un anillo preasignado, para un dato
que se puede reconstruir con una suma.

## Consecuencias

- El test que tenía que haber visto esto decía `expect(x + 0).toBeGreaterThanOrEqual(0)`, que es cierto
  para cualquier x. Queda sustituido por los dos que fallan sin el arreglo: uno que comprueba que la
  evidencia lleva fechas de este siglo y otro que cuenta una request de dentro de la ventana como
  observada y una anterior como adjunta.
- Dentro del mismo milisegundo la distinción no es resoluble: el inicio de la captura es un milisegundo
  entero y el de una request es una fracción. Los tests dejan una separación deliberada en vez de fingir
  una precisión que la medida no tiene.
- El resumen grueso y los agregados no estaban afectados: fechan sus intervalos con `Date.now()`.
