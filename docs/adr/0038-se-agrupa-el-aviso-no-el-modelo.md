# ADR 0038 — Se agrupa el aviso, no el modelo

Estado: aceptado · Fecha: 2026-09-09 · Alcance: público

## Contexto

`product.md` define hallazgo e incidente como cosas distintas y dice para qué sirve la diferencia:

> Una base de datos que se degrada y afecta a nueve endpoints produce nueve hallazgos y un incidente, **no nueve
> alertas**. La agrupación es lo que hace que el aviso hable del problema y no de sus síntomas; **su regla
> concreta es una decisión de spec**.

El cloud tenía una sola cosa y la llamaba incidente: una fila por huella. `Deliver` recorría las filas y mandaba
un mensaje por cada una. Nueve rutas degradadas por la misma base de datos eran nueve mensajes casi idénticos.

Es el ruido que el ADR 0015 quiso evitar limitando los avisos a dos por incidente, entrando por la otra puerta:
dos por incidente está bien si un incidente es el problema, no si es cada síntoma.

## Decisión

**Se agrupa lo que se envía, no lo que se guarda.**

El cloud llama «incidente» a lo que `product.md` llama **hallazgo**, y arreglar ese vocabulario significa
renombrar una tabla, un recurso de la API y un campo del webhook —el contrato que fijó el ADR 0022—. Este ADR no
lo toca. La contradicción observable hoy es el ruido, y el ruido está en el envío. El vocabulario tiene su propio
tiquet y su propio camino de migración; decidirlo de pasada, dentro de un cambio sobre avisos, sería la peor
forma de tomarlo.

**Se agrupa por dependencia compartida, y solo por eso.** `product.md` pide «dependencia, ventana temporal y una
explicación plausible común», y **la dependencia compartida es la explicación plausible común**: es lo único que
hoy permite afirmar que nueve síntomas son un problema. Un hallazgo sin dependencia —un error nuevo en la ruta
misma— va solo, porque agruparlo sería inventar una relación que nadie ha medido. **Nueve avisos ciertos antes
que uno inventado.**

**El entorno separa.** Dos entornos son dos despliegues (gh-179), y el mismo síntoma en staging y en producción
no es el mismo problema.

**El payload crece, no cambia.** `incident`, `endpoint` y `text` siguen apuntando al hallazgo principal —el de
más requests observadas, que es la ruta a la que más está golpeando el problema— y se **añade** `also` con los
demás. Un consumidor escrito antes de esto sigue leyendo algo cierto; uno nuevo ve el grupo. Romper el contrato
para arreglar el ruido sería cambiar un problema por otro.

**Se reclaman todos antes de enviar, y si falla uno no se envía nada.** Es la regla que ya regía por fila —marcar
antes que enviar, porque un aviso duplicado cuesta más confianza que uno perdido— extendida al grupo. Media
notificación es peor que ninguna: la otra mitad llegaría después como un aviso aparte, que es justo lo que se
venía a quitar.

## Alternativas

**Agrupar también por ventana temporal, sin dependencia compartida.** Nueve rutas que empiezan a fallar a la vez
probablemente son un problema, y «probablemente» es la palabra que descarta la opción: sin algo medido que las
una, agruparlas es afirmar una relación por coincidencia, que es exactamente lo que el invariante 7 prohíbe en
las conclusiones y no hay motivo para permitirlo en los avisos.

**Modelar hallazgos e incidentes de verdad, ahora.** Es a donde esto tiene que llegar. Descartada aquí por
tamaño: tabla nueva, migración, recurso de API, campo del webhook y renombrado de lo publicado. Una spec que no
cabe en un PR.

**Agrupar también en la página y en la API.** El ruido está en el aviso, que es lo que interrumpe a alguien. Una
página con nueve filas se lee de arriba abajo sin coste.

## Consecuencias

- Una base de datos degradada manda **un** aviso que nombra la dependencia y cuenta las rutas, en vez de nueve
  que nombran cada una un síntoma.
- El vocabulario sigue torcido: la tabla, el recurso y el payload dicen «incident» donde el producto dice
  «hallazgo». Está anotado y tiene tiquet; lo que este ADR evita es que se decida sin querer.
- Un hallazgo sin dependencia sigue generando su propio aviso. Si eso resulta ruidoso en la práctica, la salida
  no es agrupar por tiempo: es dar a esos disparadores una dependencia que compartir.
