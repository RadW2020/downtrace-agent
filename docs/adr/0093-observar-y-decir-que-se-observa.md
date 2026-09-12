# ADR 0093 — `on` significa enganchado, no que se vaya a ver algo

Estado: aceptado · Fecha: 2026-09-10 · Alcance: público

## Contexto

El protocolo 0.7.0 tiene `AgentInfo.observers` y el cloud ya lo guarda y lo enseña por instancia. **Nadie lo
mandaba**, así que la columna estaba vacía: es la mitad de instrumentación del gh-180, y llega tarde por el
orden del ADR 0008, que es el correcto.

Sin ella, el cloud no distingue un servicio que **no usa** Redis de uno que **lo usa y no lo está mirando**:
los dos se ven igual, sin ninguna fila con dependencia `redis`. Y no hace falta configurarlo mal para caer
ahí: `instrumentPg` no parchea nada si no encuentra `pg` resoluble desde la raíz de la aplicación —un
monorepo, un bundle— y lo dice en un `log.debug` que sin `DOWNTRACE_DEBUG` no ve nadie.

## Decisión

**Se manda un estado por interruptor, calculado en `start()` y no en el constructor**, porque lo que interesa
es lo que se enganchó y no lo que se pidió.

- **`off`** es «no se pidió». Los cuatro se mandan siempre, `off` incluido: no observar nada es una respuesta,
  y callarla sería la ausencia, que significa «este emisor no lo dijo» —lo que dice una instrumentación
  anterior a 0.7.0—.
- **`unavailable`** es «se pidió y no pudo engancharse». Hoy solo `pg` puede darlo, porque es el único que
  resuelve un módulo, y `instrumentPg` ya devolvía la versión o `undefined`: la señal existía y no la
  escuchaba nadie.
- **`on`** es «está enganchado». Para `http` y `redis` eso significa que la suscripción al canal de
  diagnóstico se hizo, y suscribirse no puede fallar: el canal existe lo publique alguien o no.

## El residuo, dicho

**`on` no garantiza que se vaya a ver algo.** Un `ioredis` demasiado viejo para publicar en `ioredis:command`
deja la suscripción hecha y muda, y el cloud leería `redis: on` sin filas. Es menos malo que lo anterior
—donde no se sabía siquiera si se estaba mirando— y sigue siendo un hueco. Cerrarlo pide detectar la versión
del módulo, que es lo que `pg` hace y `redis` no, y es otro trabajo. Queda escrito para que no se descubra
como sorpresa.

Es la misma clase de honestidad que el propio campo persigue: el estado dice lo que se sabe, y lo que no se
sabe no se inventa.

## Alternativas

**Calcularlo en el constructor, desde `DOWNTRACE_INSTRUMENT`.** Es más simple y es exactamente el error que
el campo existe para evitar: diría `pg: on` en el monorepo donde `pg` no se resuelve, que es el caso que abrió
el tiquet.

**Mandar solo los que están `on`.** Ahorra cuatro claves y pierde la distinción entre «apagado» y «no dicho»,
que es la mitad del valor.

## Consecuencias

- La instrumentación tiene una costura nueva, `deps.pgModule`, que reenvía al `moduleImpl` que
  `instrumentPg` ya ofrecía. Sirve para probar el camino de `unavailable` sin depender de que la resolución
  de módulos falle, que bajo el ejecutor de tests **no falla**: `createRequire` con una ruta inexistente
  seguía resolviendo `pg`. Un test que se apoyara en eso probaría el entorno y no el código.
- `AgentInfo` se llena en dos momentos: se construye en el constructor y su `observers` se escribe en
  `start()`. El emisor lo lee al vaciar, que siempre es después. Está dicho donde se construye.
- El protocolo exporta ahora `Observers` y `ObserverState`, que estaban generados y no re-exportados.
