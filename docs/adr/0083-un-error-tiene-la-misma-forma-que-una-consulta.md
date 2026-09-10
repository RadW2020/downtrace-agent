# ADR 0083 — Un error tiene la misma forma que una consulta, y su mensaje se sanea más fuerte

Estado: aceptado · Fecha: 2026-09-10 · Alcance: público

## Contexto (gh-338)

`product.md:77`: «Errores y excepciones: **tipo, mensaje saneado, firma del stack**». No existía. Lo que
había eran contadores —errores por ruta, llamadas fallidas por dependencia—, que dicen **cuántos** y no
**cuáles**. La diferencia entre «esta ruta empezó a fallar» y «esta ruta empezó a lanzar **esto**» es la que
el producto vende.

Tenía una consecuencia ya medida: el gh-337 encontró que la hipótesis `an-operation-started-failing` no podía
apoyarse nunca porque su evidencia no la producía nadie. Aquello arregló que no se descartara sin evidencia;
esto produce la evidencia.

## Decisión

**1. Un error tiene la forma de una consulta.** `{text, hash}`, y viaja como una operación más del perfil con
`kind: "error"`. No hace falta ningún campo nuevo, que es exactamente lo que el **ADR 0017** dejó preparado:
«queries and error signatures share one shape, so the next kind needs no new field».

**2. Una operación aparte, no un campo de la que falló.** La consulta ya lleva su contador de errores. Lo que
se añade responde otra pregunta: cuántas veces ocurre **este error**, que no es cuántas veces falla esa
consulta —el mismo error puede venir de varias, y la misma consulta fallar por varios—. El cloud las cuenta
por separado porque son dos cosas.

**3. El texto lleva las tres cosas y el hash es del texto.** Una regla, la misma que las consultas. El tipo,
el mensaje saneado y la firma del stack, en un texto que una persona lee.

Eso decide algo que parecía menor: el mismo error en el mismo sitio **agrupa** aunque el mensaje varíe
—porque lo que varía son los valores y esos se sanean—, y la misma frase desde otro sitio **no** agrupa. La
identidad es del código, no de la oración.

**4. El mensaje se sanea más fuerte que una consulta, y a propósito.** Es el sitio más probable de todo el
producto donde aparece un dato de un cliente: un identificador, un correo, un token, una IP. El saneo es
**deliberadamente ansioso** —cualquier palabra con un dígito dentro se va—, y la razón es asimétrica: un
falso positivo cuesta un `?` donde se habría leído mejor una palabra; un falso negativo pone el
identificador de un cliente en un lote, y eso no se deshace.

Y una tirada de valores separados solo por puntuación se colapsa en uno: «expected 1, 2, 3» y «expected 4, 5»
son el mismo error, y dejar tres interrogantes los haría dos.

**5. La firma del stack pierde el directorio y conserva el fichero.** El nombre del fichero y la línea son la
estructura del código del usuario —como una plantilla de ruta— y son lo que hace legible una firma. El
directorio delata el `$HOME` de quien compiló y la ruta de despliegue, y no dice nada del error. Los marcos
de `node:` y de `node_modules` se colapsan a su paquete, o toda firma sería mayormente librería.

**6. Se observa donde ya hay contexto.** Una operación instrumentada que falla tiene ruta y tiene request, que
es lo que la evidencia necesita. Las excepciones **no capturadas** del proceso no tienen ruta y no caben en un
perfil por endpoint: van a su propio tiquet.

## Alternativas

**Un campo `error` en la operación que falló.** Más barato y responde una pregunta menos, por la decisión 2.

**Hashear el tipo y el stack sin el mensaje.** Agrupa igual de bien y deja el texto libre para variar, lo que
hace que la etiqueta parpadee entre dos ocurrencias del mismo hash. Con el mensaje saneado dentro del texto,
mismo hash implica mismo texto, que es la propiedad que las consultas ya tienen.

**Un saneo conservador**, que solo quite lo que seguro es un valor. Es la elección cómoda y la equivocada aquí:
el coste de los dos errores no es el mismo.

**Guardar el mensaje entero y sanear en el cloud.** El dato ya habría salido del servidor del usuario. El
invariante 5 es sobre lo que se envía, no sobre lo que se muestra.

## Consecuencias

- La hipótesis del gh-337 y el patrón `new-error` empiezan a tener evidencia que leer, sin tocar el cloud.
- Una caché por error distinto, con la misma política que la de consultas: se deja de admitir en vez de
  desalojar, porque una aplicación que lanza errores distintos sin fin es justo la que reventaría un LRU.
- Solo Postgres, que es lo único con huella hoy. Redis y el HTTP saliente van por contadores de dependencia y
  no tienen perfil; cuando lo tengan, tendrán esto.
