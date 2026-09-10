# ADR 0104 — Un nombre retenido se marca en el dato, no se deduce del proyecto

Estado: aceptado · Fecha: 2026-09-10 · Alcance: público

## Contexto

`product.md:104` promete un **modo mínimo** «en el que ningún texto libre sale del servidor». La plantilla
de ruta es texto libre del servidor del usuario **y** es la mitad de la identidad de un endpoint: el cloud
agrupa por (método, ruta) y el esquema la exige con `minLength: 1`. Así que algo tiene que viajar, y ese
algo es un hash.

Y entonces el cloud enseñaría `a3f2c1d4` donde ponía `/orders/:id`. Un informe cuyo alcance es un hash y no
dice por qué es exactamente el silencio que el invariante 14 no admite.

Esta es la mitad de cloud (gh-389); el interruptor es el gh-390.

## Decisión

**El dato se describe a sí mismo: una ruta que empieza por `#` es un nombre que el emisor retuvo.**

Una plantilla de ruta siempre empieza por `/`, y el único valor que hoy no lo hace es `(other)`. El prefijo
está libre y no puede confundirse con nada. Lo mismo para el objetivo de una dependencia.

**Por qué no deducirlo de la declaración del proyecto.** El `withholding` del ADR 0092 dice que un emisor
retiene texto libre, y sería tentador leer todas sus rutas como hashes. Falla justo donde importa: durante
un despliegue a medias, un entorno tiene instancias que retienen y otras que no, y las rutas **reales** de
las segundas se leerían como hashes. El dato sabe lo que es; el proyecto no puede saberlo por él.

**La identidad se conserva y la presentación cambia.** La API sigue devolviendo el hash —un consumidor
necesita algo por lo que agrupar— y añade `nameWithheld`, que es lo que impide presentarlo como si fuera un
nombre. La página nunca enseña el hash a secas: dice que el nombre se retuvo, con los ocho primeros
caracteres para poder distinguir dos.

**El método no se retiene.** `GET` no lo escribió el usuario, y perderlo le costaría al lector lo poco que
le queda.

## Alternativas

**Un campo aparte, `routeWithheld: true`, junto a la ruta.** Dice lo mismo y se puede quedar desincronizado
del valor que describe. El prefijo no puede.

**Enseñar el hash y ya.** Es lo que pasa si no se hace nada, y es la definición de un dato que no explica su
propia ausencia.

**Que el cloud no acepte una ruta sin nombre.** Convierte el modo mínimo en no tener producto.

## Consecuencias

- La narración por plantilla (ADR 0079) usa la misma función, así que no escribe una frase que nombra algo
  sin nombre.
- El porqué ya está a mano y no hace falta repetirlo en cada fila: el `withholding` del proyecto dice que
  ese emisor no manda texto libre y desde cuándo, y sale entre las limitaciones de cada resultado (ADR
  0092).
- `endpoints[].route` sigue declarado en `fieldsFromService`, y eso sigue siendo cierto: la lista promete
  que un campo **puede** llevar texto del servicio, no que siempre lo lleve.
- Nada manda todavía un nombre retenido: es la forma del ADR 0008, y el gh-390 es quien lo hará.
