# ADR 0105 — Qué cuenta como «texto libre», decidido mirando el lote

Estado: aceptado · Fecha: 2026-09-10 · Alcance: público

## Contexto

`product.md:104` promete un **modo mínimo** «en el que ningún texto libre sale del servidor». Antes de
decidir qué apagar había que saber qué sale, y eso no se decide de memoria: con `DOWNTRACE_INSPECT` sobre
la app de referencia se listó **cada cadena** que un lote lleva hoy y se ordenó por quién la escribió.

| campo | ejemplo | ¿del usuario? |
|---|---|---|
| `protocol`, `agent.*`, `instance.id` | `0.7.0`, `@downtrace/agent`, un uuid | no |
| `endpoints[].method`, `dependencies[].kind` | `GET`, `postgres` | no, vocabulario cerrado |
| `operations[].hash` | `8bf8bca7…` | no, es un resumen |
| `endpoints[].route`, `profile…route` | `/checkout` | **sí** |
| `dependencies[].target` | `localhost:55432` | **sí** |
| `operations[].text`, firmas de error y de excepción | el SQL, el mensaje | **sí** |
| `instance.hostname` | `RAULs-MacBook-Pro.local` | **sí** |
| `deploy.version` | `v2.4.1-acme` | **sí** |
| `deploy.environment` | `production` | sí, y ver abajo |

**Tres de ellos no estaban en el tiquete** —el hostname, la versión desplegada y el entorno—. Salieron del
inventario, que es exactamente para lo que se hace.

## Decisión

**Se retiene lo que el usuario escribió. Lo nuestro y lo de Node se queda**, porque sin `protocol` no hay
contrato, sin `method` no hay endpoint y sin `kind` no hay dependencia.

**Lo que tiene identidad viaja como identidad**: la ruta, el objetivo, el hostname y la versión se
convierten en `#` + un resumen estable de sí mismos (ADR 0104). Estable entre lotes y entre procesos, o el
cloud no podría agrupar nada y el modo costaría el análisis entero.

**Lo que sólo es palabras no viaja**: el texto normalizado de las consultas, los mensajes de error y las
firmas de las excepciones. Donde hay clase —una consulta que el normalizador no entendió— la clase sí, que
es una de cinco constantes nuestras.

## Las dos exclusiones, razonadas

**`deploy.environment` no se retiene.** El token de ingesta ya le dice al cloud de qué entorno viene el
lote (gh-191), así que ocultarlo aquí **no protege nada** —el cloud lo sabe igual— y rompería el alcance
por entorno, que es como está organizado el producto entero: dos entornos son dos ventanas, dos huellas y
dos incidentes.

**`DOWNTRACE_QUERY_TEXT=off` se queda.** El modo mínimo lo subsume, y aun así sigue teniendo sentido por su
cuenta: «manda mis rutas pero no mis consultas» es una cosa que alguien quiere, y deprecar algo publicado
(ADR 0046) a cambio de nada es peor que tener dos controles.

## Consecuencias

- El test recorre **el cuerpo serializado** buscando cada cosa que el operador escribió, y valida contra el
  esquema: una versión más fuerte, y del revés, del guardián `fieldsFromService` del cloud.
- Escribirlo destapó un segundo fallo, que va en el mismo PR y tiene tiquete propio (gh-392): un proceso
  que observa algo y se va **dentro del mismo milisegundo** producía `durationMs: 0`, que el esquema
  rechaza — y entonces no sólo se perdía el perfil, sino el lote entero con sus agregados, más un episodio
  de pérdida de cobertura por lo que es un error de redondeo. Se declara un milisegundo: la ventana existió
  y tuvo operaciones dentro.
- La retención ocurre **después** de decidir la exclusión (ADR 0101), para que un patrón se compare con la
  plantilla real y no con un resumen de ella.
- Queda fuera **la evidencia de una captura**, que lleva rutas dentro: con el modo mínimo puesto sería un
  agujero del tamaño de una captura. Tiquete aparte.
