# ADR 0036 — La marca del contenido del usuario se llama `fromService`, y hay una lista que la comprueba

Estado: aceptado · Fecha: 2026-09-09 · Supera la elección de clave del ADR 0034 · Alcance: público

## Contexto

El ADR 0034 decidió, hace unas horas, que el contenido escrito por el servicio del usuario viviera bajo una clave
**`observed`**. Estaba mal elegida, y de una forma concreta: **`observed` ya significaba otra cosa en esta misma
API**. En el detalle de un incidente, `observed` es lo que se **midió**, en oposición a `attributed`, que es lo
que el incidente mostró **después** de un despliegue. Esa oposición es una de las ideas centrales del producto y
la fijó el ADR 0022.

Dos significados de la misma palabra en la misma API es exactamente lo que DOC-01 prohíbe para los
identificadores de producto, y no hay razón para que un nombre de campo se libre de esa regla.

Además quedaba pendiente lo que el gh-204 pedía de verdad: que el invariante 12 se pueda comprobar y no solo
prometer. La API devuelve contenido del usuario en sitios inevitables —una plantilla de ruta, el host de una
dependencia, una versión desplegada, la etiqueta de un entorno— y en dos campos en prosa que necesariamente lo
embeben, porque existen para que una persona los lea.

## Decisión

**La clave se llama `fromService`.** Dice de dónde viene el dato, que es lo único que esa marca tiene que
comunicar, y no se puede confundir con «medido». El que se mueve es el nuevo: `observed` en el detalle de un
incidente lleva publicado desde el ADR 0022 y `fromService` tenía una hora.

**Los campos ya publicados no se mueven.** Sacar `endpoint.route` o `attributed.candidates` a otra clave rompería
a quien los consume; duplicarlos crearía dos fuentes para el mismo valor, que es lo que este producto no hace. Lo
que faltaba no era mover: era que existiera **un sitio donde estuviera escrito cuáles llevan contenido del
servicio**.

**Ese sitio es una lista en el código, y un guardián la comprueba.** `fieldsFromService` enumera las rutas de
campo que pueden llevarlo. Un test construye cada respuesta con valores inconfundibles —una ruta, un host, una
versión, un entorno, una consulta, un nombre de máquina, todos con una marca que ninguna prosa nuestra
contendría—, recorre el JSON entero y **falla si uno aparece en un campo que no está en la lista**.

Documentar sin comprobar es cómo se erosionan estas cosas: una lista de rutas de campo sin test detrás queda
incompleta al primer campo nuevo, y nadie lo nota. Escribiendo este ADR el guardián encontró `evidence.deploy` en
el payload del webhook, que se me había pasado. Esa es la prueba de que hacía falta.

## Alternativas

**Reescribir la prosa para que no embeba nada.** Funciona para `headline`, que ya solo traduce un disparador a
palabras. No funciona para la frase de un aviso, que existe para que alguien la lea en Slack y decida: una frase
que no nombra la ruta es una frase sobre nada. Se declara en la lista en vez de fingir que no ocurre.

**Mover los campos publicados bajo `fromService`.** Es lo limpio en un diseño nuevo y aquí rompe el contrato del
ADR 0022 sin comprar nada que la lista no compre.

**Duplicar los valores bajo `fromService` además de donde están.** Sin romper a nadie, y con dos fuentes para el
mismo valor que pueden discrepar. Precisamente el fallo contra el que existe la disciplina de «un hecho, un
sitio».

**Dejar `observed` y renombrar el del incidente.** Habría roto lo publicado para acomodar lo que llevaba una hora.

## Consecuencias

- Añadir un campo que devuelva contenido del servicio y no declararlo **rompe el test**, que es el único
  mecanismo que impide que esto se erosione.
- La lista es una promesa de que un campo **puede** llevarlo, no de que siempre lo lleve. Un consumidor que
  quiera auditar tiene dónde mirar sin adivinar.
- El ADR 0034 sigue en pie en todo lo demás —por qué se marca por estructura y no por anotación, y por qué la
  ausencia de texto tiene tres respuestas—; solo su elección de clave queda superada aquí.
- Queda una asimetría honesta: la lista cubre lo que la API devuelve, no lo que la página renderiza. El HTML lo
  lee una persona y ahí la mezcla es el objetivo.
