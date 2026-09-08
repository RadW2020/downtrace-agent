# ADR 0009 — Cómo el agente observa el driver de base de datos

Estado: aceptado; su consecuencia sobre que el bench comprueba el presupuesto en cada ejecución de CI está **superada por el ADR 0032** · Fecha: 2026-09-05 · Alcance: público

## Contexto

Para detectar un N+1 (`docs/product.md`) hace falta saber cuántas queries hizo **cada request**, no cuántas hizo el proceso. Eso exige dos cosas: un contexto por request que sobreviva a los `await`, y ver las queries que ejecuta el driver del usuario. `pg` 8.23 no publica nada en `diagnostics_channel`, así que hay que envolver `Client.prototype.query`. La promesa del producto es "añadir una librería y una variable de entorno": el usuario no debe tocar su código. Y el invariante del repo dice que nada en `packages/` referencia al agente, así que la app de referencia tampoco puede importarlo: lo que se mide se inyecta con `--import`.

Se probaron tres mecanismos sobre Node 26 antes de decidir (las pruebas están en el PR de gh-34):

- `channel.bindStore()` sobre `http.server.request.start`: el canal lo soporta, pero el servidor HTTP publica con `publish()` y no con `runStores()`, así que no llega ningún store al handler.
- `Module._load` parcheado: **no** intercepta un `import "pg"` desde una aplicación ESM en Node 26. Solo veríamos aplicaciones CommonJS.
- `module.register()` con hooks de carga: funciona, pero para envolver un módulo CommonJS desde un hook ESM hace falta la maquinaria de `import-in-the-middle`, es decir, una dependencia nueva y un punto de fallo con bundlers.

## Decisión

- **Contexto por request con `AsyncLocalStorage` y `enterWith`** desde el subscriptor de `http.server.request.start`. Node publica ese evento dentro del contexto asíncrono de la propia request, así que el store alcanza al handler y a todo lo que este espere. Verificado con 24 requests concurrentes sobre conexiones reutilizadas: ninguna cuenta el trabajo de otra.
- **El agente resuelve `pg` desde la raíz de la aplicación y parchea el prototipo al arrancar.** El agente se carga antes que la aplicación (`node --import`); los módulos CommonJS se cachean por ruta resuelta, de modo que la instancia que la aplicación importe después es la que ya está instrumentada. Sirve igual si la aplicación es ESM o CommonJS, no añade dependencias y no toca el resolutor de módulos.
- **El envoltorio no cambia nada de lo que ve la aplicación**: mismos argumentos, mismo resultado, mismo error, mismo orden de resolución. Cubre la forma de promesa y la de callback; un `Cursor` o un `QueryStream` no es *thenable* y pasa de largo sin medirse. Cualquier fallo del envoltorio ejecuta la query original.
- **Solo se cuenta**: número de queries, suma de duraciones y máximo. Nunca el texto de la query ni sus valores, en v1 ni siquiera su huella.
- **`DOWNTRACE_INSTRUMENT=none`** desactiva el envoltorio sin desactivar el agente.

## Alternativas descartadas

- **`instrument(pg)` explícito**: siempre funciona y no tiene magia, pero obliga al usuario a tocar su código y haría imposible medir el overhead con la app de referencia, que por invariante no puede depender del agente. Queda como salida si algún día aparece un entorno donde el parcheo temprano no sirva.
- **Hooks de carga de módulos con `import-in-the-middle`**: una dependencia más en el paquete público y un punto de fallo con bundlers, a cambio de cubrir un caso que el parcheo temprano ya cubre.
- **`enterWith` frente a `run()`**: `run()` sería más limpio, pero exige envolver la ejecución del handler, y el agente no la controla sin parchear `http.createServer`.

## Consecuencias

- El orden importa: el agente debe cargarse antes que la aplicación. Ya es el modo de uso documentado (`node --import @downtrace/agent/register`), y sin él el agente tampoco vería las requests.
- Una aplicación que cargue `pg` por una ruta que el agente no resuelva (varias copias de `pg` en el árbol, un bundle) no queda instrumentada: el agente lo dice en modo depuración y sigue funcionando sin la composición.
- Añadir MySQL, Redis o HTTP saliente sigue este mismo patrón; cada driver nuevo es un módulo bajo `src/instrument/`.
- El coste por request entra en el presupuesto del invariante 3. **Esta consecuencia está superada por el ADR
  0032**: el benchmark salió del pipeline el 2026-09-08 y ya no comprueba nada en cada ejecución de CI; se
  lanza a mano con `make bench`. La decisión de este ADR no cambia; lo que dejó de ser cierto es quién la
  vigila.
