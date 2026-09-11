# ADR 0108 — La caja negra guarda, por request, las dependencias que tocó

Estado: aceptado · Fecha: 2026-09-11 · Alcance: público

## Contexto

La orden de captura dice qué mirar: una ruta o una dependencia (`PendingCapture`). La instrumentación lo
tiraba y mandaba el registro fino entero, así que una captura de `GET /a` llevaba el nombre, los tiempos y
la composición de todas las demás rutas del servicio, y las dos coberturas que CAP-01 exige contaban todo
el tráfico del proceso en vez de lo que se preguntó.

Filtrar por ruta es inmediato: la fila ya la guarda. Filtrar por dependencia no lo era. El registro guarda
operaciones por **huella**, y una huella no dice de qué dependencia es; peor, las llamadas a Redis o a un
HTTP saliente no producen ninguna operación —solo contadores por dependencia—, así que había requests que
usaron una dependencia y no dejaban ni rastro en el registro.

## Decisión

**Cada request guarda, además de sus operaciones, las dependencias que tocó.** Hasta ocho, interned como
las rutas, en un anillo propio dimensionado a `capacidad de requests × tope por request`: así, mientras
una request se pueda leer, sus etiquetas siguen vivas. Un anillo más corto haría que la más antigua
pareciese una request que no tocó nada, que es la lectura que el invariante 14 prohíbe.

**La etiqueta es la que ya existe.** `dependencyKey(kind, target)` es la clave con la que el contexto de
la request ya agrupa su trabajo, así que las cadenas que el registro guarda son las que ya estaban
construidas: la ruta caliente no paga ninguna asignación nueva. Y al ser una sola función, el lado que
escribe y el que compara no pueden divergir.

**Una lista incompleta conserva la request.** Si tocó más de ocho, la fila lo dice y una captura de
dependencia **la incluye**: no se puede demostrar que no usó la novena, y descartarla sería leer un hueco
como un hecho.

**Una orden sin ruta ni dependencia sigue significando todo.** Es una captura de entorno, y es lo que
hacía antes para todas.

## Alternativas

**Un bitmask de dependencias interned en un solo campo.** Ocho bytes por request en vez de un anillo, y un
límite duro a los 53 bits que nadie vería hasta que un servicio con muchos destinos empezara a perder
requests en silencio. Más barato y menos honesto.

**No filtrar las capturas de dependencia y decirlo.** Necesitaría un campo nuevo en el contrato para
declarar que la evidencia no está filtrada, y dejaría el caso a medias justo donde el presupuesto de
evidencia más se nota.

**Deducir la dependencia de las huellas de las operaciones.** Solo funciona para Postgres, que es lo único
que produce operaciones, y falla precisamente en las dependencias —Redis, HTTP saliente— para las que se
pide una captura cuando se degradan.

## Consecuencias

- Las dos coberturas se cuentan sobre lo filtrado, así que por fin dicen lo que su descripción dice.
- El registro fino crece en `4096 × 8` números —256 KiB— y sigue dentro de su tope declarado, que un test
  comprueba.
- El e2e pide ahora dos capturas, una de ruta y otra de dependencia, y comprueba que cada una trae lo suyo
  y no lo ajeno. Revertir el filtro lo rompe: «a capture of GET /products carries GET /products/:id».
- La lista de dependencias no viaja: es para decidir qué se manda, no parte de la evidencia. Si algún día
  hace falta en el cloud, será un campo del contrato y su propio tiquet.
