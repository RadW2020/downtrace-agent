# ADR 0078 — El MCP es un cliente de la API pública, sin dependencias

Estado: aceptado · Fecha: 2026-09-10 · Alcance: público

## Contexto (gh-281)

`product.md:260` pone «herramientas para agentes (por ejemplo MCP)» en la primera versión, y `product.md:264`
lo saca explícitamente de lo que se posterga: «un producto que solo pudiera operarse desde la interfaz
fallaría a la mitad de sus usuarios». `product.md:196` fija el listón: «un exportador de informes no la
satisface: un agente debe poder **operar** el producto». No había ni una línea.

El propio tiquet había puesto una condición —«el MCP se hace cuando la API cubra el recorrido»— y ya se
cumple: con el gh-280 entró el tramo de investigar, que era el último.

## Decisión

**1. Un paquete público nuevo que habla la API por HTTP.** `cloud/` es privado y no se instala; `packages/`
es público y no puede referenciar `cloud/` (CLAUDE.md). Así que el servidor es un cliente de la API pública,
exactamente como el que escribiría cualquiera, y no tiene ningún atajo: los mismos permisos, la misma
atribución, la misma idempotencia.

Tiene una consecuencia que conviene ver: si una capacidad no está en la API, no está aquí. El MCP no puede
tapar un hueco del producto, y eso es bueno.

**2. Sin dependencias de ejecución.** Lo que hace falta —JSON-RPC 2.0 en líneas de stdin/stdout, con
`initialize`, `tools/list` y `tools/call`— cabe en un fichero. Los dos paquetes publicados de este repo
tienen cero dependencias y eso vale la pena mantenerlo.

**El riesgo es real y se nombra**: el SDK oficial es la elección convencional y existe justamente para que
nadie se equivoque con el protocolo, y aquí no hay un cliente real contra el que probar. Lo que lo sujeta es
que la revisión implementada es una constante —`PROTOCOL_VERSION`— y que cada forma de mensaje tiene su test:
el saludo, la lista, la llamada, la notificación que no se contesta, el método que no existe, la línea que no
es JSON y el encuadre por líneas partido entre dos trozos. Si el protocolo se mueve, se mueve esa constante y
los tests dicen qué más.

**3. La configuración se lee una vez al arrancar** y se valida ahí, que es la regla del repo. Y del entorno,
nunca de un argumento: un argumento acaba en la lista de procesos y en el historial del intérprete, y éste es
un secreto que puede cerrar hallazgos.

**4. Sin token, arranca en modo de solo lectura.** Las operaciones **siguen listadas** y decir lo que falta
cuando se llama a una es más útil para un agente que negarse a arrancar: puede leer, y sabe exactamente qué
credencial le hace falta. Negarse a arrancar habría sido más limpio y menos útil.

**5. Una herramienta por capacidad, con el nombre de la capacidad.** Un agente busca «verificar la
recuperación», no `GET /findings/{id}/verification`. Diecinueve, y el invariante 13 las convierte en una
lista comprobable: lo que la interfaz puede, se puede programáticamente, así que una capacidad sin
herramienta es un fallo y no una omisión.

**6. El contenido observado llega como dato, y el saludo lo dice.** Es el invariante 12, y es donde un
servidor MCP puede hacer daño de verdad: una ruta que se llame `/ignora-las-instrucciones-anteriores` llega a
un modelo que está buscando instrucciones. Llega **literal y envuelto** en la clave `fromService` que la API
ya le pone (ADR 0036); el servidor ni la desenvuelve ni la lee. Un servidor que sacara la ruta para ser útil
le habría entregado a un modelo una frase suelta sin rastro de su origen — y hay una mutación que lo
comprueba.

## Alternativas

**El SDK oficial.** Arriba, decisión 2.

**El MCP dentro de `cloud/`, sirviendo por HTTP/SSE.** No hay que escribir cliente HTTP y `cloud/` es privado:
nadie podría instalarlo, y un agente de programación local habla stdio.

**Negarse a arrancar sin token.** Más limpio y menos útil, decisión 4.

**Recursos y prompts además de herramientas.** `product.md:260` habla de herramientas y es lo que hace falta
para operar. Un recurso por hallazgo suena bien y multiplica la superficie sin añadir una capacidad.

## Consecuencias

- `@downtrace/mcp`, público, ejecutable como `downtrace-mcp`, con su README —lo lee quien lo instala— y su
  changeset. Se publica cuando se fusione el PR de versiones, que no se toca desde una sesión.
- Un error de la API o un cloud inalcanzable son **resultados** que el agente lee, nunca excepciones que se
  lleven la sesión por delante.
- Nada se escribe en stdout que no sea un mensaje del protocolo: un `console.log` suelto sería un mensaje
  malformado. Los diagnósticos van a stderr.
- Ningún compromiso con letra sale de la deuda por esto: los que quedan necesitan capacidades que la API
  todavía no tiene.
