# ADR 0071 — La orden de captura viaja en la respuesta del ingest

Estado: aceptado · Fecha: 2026-09-10 · Alcance: público

## Contexto (gh-320)

Con el gh-312 el cloud sabe qué capturas existen y no tiene forma de decírselo a nadie. La comunicación es de
un solo sentido: la instrumentación hace `POST /v0/aggregates` y el cloud contesta
`{"accepted":N,"inserted":M}`, un cuerpo que la instrumentación **ni siquiera lee**.

`product.md:257` quiere capturas «por disparador local, **por petición del cloud** y por petición de un
consumidor». La del medio necesita un canal que no existe.

## Decisión

**1. La orden viaja en la respuesta del ingest.** Frente a las otras dos opciones que el gh-277 nombraba:

- Un **canal aparte** —websocket, o el cloud llamando a la instrumentación— exige que el proceso del cliente
  sea alcanzable desde fuera. `packages/` no puede asumir puertos ni secretos, y la mayoría de los despliegues
  que este producto sirve están detrás de un balanceador que no enruta hacia dentro.
- Un **long-poll** cuesta al cloud una conexión abierta por proceso del cliente, que es la magnitud que peor
  escala de todas las que hay aquí: un cliente con cuarenta instancias son cuarenta conexiones ociosas.
- La **respuesta del ingest** no abre nada, no añade secretos y no mantiene nada abierto. Su precio es la
  latencia de un intervalo: hasta diez segundos entre pedir una captura y que alguien se entere. Para un
  producto cuya unidad de medida **es** el intervalo de diez segundos, ese precio es exactamente uno.

**2. La respuesta pasa a ser contrato.** Hasta ahora el esquema describía solo lo que sube. Un cuerpo que
lleva órdenes y no tiene esquema es un cuerpo que dos implementaciones leerán distinto. `ingest-response.schema.json`
vive junto al del lote, con sus fixtures, y `make gen` genera de los dos. Las reglas son las mismas: solo se
añaden campos, cada adición sube la minor, una minor publicada se acepta para siempre.

Con una obligación de más, que es la que ordena todo esto: **`accepted` e `inserted` son requeridos y no se
mueven.** Son los dos campos que la instrumentación publicada nunca leyó; el día que empiece a leer el cuerpo,
encontrarlos ausentes sería indistinguible de un cloud que no aceptó nada.

**3. Se manda lo del entorno del lote, no lo del proyecto.** Una instancia de `staging` no tiene por qué
enterarse de lo que se captura en producción, y una captura de una ruta que solo existe en un entorno sería
una orden que nadie puede obedecer. Y solo las vivas y no caducadas: la caducidad se mira en la consulta, así
que una captura deja de pedirse en el instante en que expira, sin esperar a la retención.

**4. Varias instancias del mismo entorno reciben la misma orden.** La alternativa era repartir, una instancia
por captura. Exige que el cloud sepa qué instancia sigue viva, y lo que sabe es cuál mandó hace poco, que no es
lo mismo: una captura asignada a un proceso que acaba de morir se pierde **en silencio** hasta caducar. Sin
reparto llega evidencia de varias instancias y el cloud la junta, que es trabajo de más y no silencio. El
invariante 14 decide: que no lleguen datos no puede significar que no pase nada.

## Alternativas

Las tres del canal están arriba. Dos más:

**Meter las capturas en una cabecera** en vez de en el cuerpo. Evitaría convertir la respuesta en contrato,
que es la parte cara de esto. Descartada: una lista de objetos en una cabecera es JSON dentro de una cadena,
sin esquema y sin tipos generados, que es exactamente lo que la decisión 2 evita.

**No acotar la lista.** El campo lleva un tope de dieciséis. Una cola desbocada de un proyecto no puede
convertir cada respuesta del camino caliente en un cuerpo largo, y el límite de simultáneas ya está muy por
debajo. El tope vive en el esquema, que es donde el contrato se puede comprobar.

## Consecuencias

- Protocolo **0.7.0**, la misma minor sin publicar que ya traía `observers`. `@downtrace/protocol` exporta `IngestResponse`, `PendingCapture` y
  `INGEST_RESPONSE_SCHEMA_V0`.
- El tipo TS de `captures` es un array llano y no la unión de diecisiete tuplas que el tope produciría: el de
  `intervals` quiere esa unión porque su longitud se conoce donde se construye, y esto es una lista que solo se
  lee. El tope sigue en el esquema, que es donde se comprueba.
- Un fallo al preguntar por las capturas se registra y se traga: el lote ya aterrizó, y convertir una
  instrucción perdida en un 500 haría que la instrumentación reenviara datos que el cloud ya tiene. La captura
  viaja en el siguiente lote, un intervalo después.
- **La instrumentación de hoy no se entera**, y hay un test suyo que lo prueba contra un cloud que responde con
  capturas: mismo estado, mismas llamadas, y también con un cuerpo que ni siquiera es JSON.
- **CAP-01 y ESC-08 siguen en la deuda.** Falta la evidencia (gh-322) y la instrumentación (gh-277).
