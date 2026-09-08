# ADR 0037 — Tres estados de observador en el protocolo, y un cuarto en el cloud

Estado: aceptado · Fecha: 2026-09-09 · Alcance: público

## Contexto

El cloud no podía distinguir **un servicio que no usa Redis** de **uno que lo usa y no lo está mirando**. Los dos
se veían igual: ninguna fila con dependencia `redis`. Es lo que COB-01 prohíbe por su nombre —«distingue
instrumentación conectada de integración activa»— y lo que el invariante 14 dice que no se infiere.

Y el caso que más duele no hay que configurarlo: `instrumentPg` no parchea nada si no resuelve `pg` desde la raíz
de la aplicación, y lo dice en un `log.debug` que nadie ve sin `DOWNTRACE_DEBUG`. Una aplicación con `pg` en otro
sitio —un monorepo, un bundle— se queda sin observar su base de datos, y lo que el cloud publica no es «sin
cobertura de Postgres» sino «este servicio no llama a ninguna base de datos». Un agente de programación que lea
eso descarta la hipótesis «dependencia degradada» con evidencia que no existe.

## Decisión

**El protocolo 0.7.0 lleva `AgentInfo.observers`, opcional, con tres estados por observador.**

- `on` — pedido y enganchado.
- `off` — no pedido.
- **`unavailable` — pedido y no se pudo enganchar.** Es el que da sentido al campo. Con solo dos estados, el
  fallo silencioso seguiría siendo indistinguible de una decisión deliberada, y un estado que no se puede
  expresar es un estado que no se puede arreglar.

**Y un cuarto que vive en el cloud y no en el protocolo: no lo dijo.** Una instancia cuya instrumentación es
anterior a 0.7.0 no informa de nada. La columna es nullable y la API devuelve `null`, no un objeto vacío: un
objeto vacío se leería como «se le preguntó y no observa ninguno», que es una afirmación, y aquí no hay ninguna.
Confundirlas sería repetir una capa más arriba el error que este ADR viene a quitar.

**Un objeto con una clave por observador, no una lista.** Valida mejor —cada clave con su enum— y se lee mejor.
Añadir un observador será un minor del esquema, que es la misma danza que ya exige `Dependency.kind`; que ese
enum ya hubiera previsto `mysql` demuestra que la danza es asumible.

**El campo usa `pg`, no `postgres`.** Son dos cosas distintas que ya conviven: el **interruptor** se llama `pg`
—`DOWNTRACE_INSTRUMENT=pg`, publicado en el README— y la **dependencia observada** se llama `postgres` en
`Dependency.kind`. Este campo describe interruptores. Unificar los nombres rompería algo publicado a cambio de
una coherencia que nadie ha echado en falta.

**Un lote que no lo trae no se erosiona.** Si una instancia reporta observadores y luego llega un lote sin el
campo —un despliegue que retrocede de versión—, se conserva lo último que sí se dijo. Escribir `null` encima
convertiría un retroceso de versión en una pérdida de información.

## Alternativas

**Deducir la cobertura de los datos.** «Lleva una hora sin filas de Redis, luego no lo observa» es exactamente
la inferencia que el invariante 14 prohíbe, y falla en los dos sentidos: un servicio ocioso parecería no
observado, y uno no observado parecería ocioso.

**Dos estados, encendido y apagado.** Más simple y pierde el caso que motiva todo esto.

**Una cadena libre por observador**, para no atarse a un enum. Descartada: un estado que no se puede validar es
un estado que cada agente escribirá a su manera, y el cloud tendría que adivinar.

**Que el agente lo mande ya, en el mismo cambio.** Lo prohíbe el ADR 0008, y con razón: si el cloud aún no
entiende el campo, el primer despliegue del agente rompe la ingesta de quien haya actualizado antes.

## Consecuencias

- **Ningún lote de un agente actual se rechaza**, y hay un test que lo fija. Es lo que protege a todos los
  despliegues que existen hoy.
- El campo está y **nadie lo envía todavía**: hasta que el gh-180 se publique, todas las instancias leerán «no lo
  dijo». Eso es correcto y es visible, en vez de ser un hueco.
- Avisar cuando un observador pasa a `unavailable` es COB-02 y sigue pendiente. Esto hace que ese aviso sea
  posible; no lo implementa.
- La página lo dice en palabras y separa el fallo de la elección: «could not attach: pg» no se lee igual que
  «off: pg», y esa diferencia es la que un operador necesita a las tres de la mañana.
