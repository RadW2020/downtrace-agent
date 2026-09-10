# ADR 0084 — Ante la duda, el mensaje no viaja

Estado: aceptado · Fecha: 2026-09-10 · Alcance: público

## Contexto (gh-343)

`product.md:104` es la única línea del documento que dice **cómo se comporta el producto cuando no está
seguro**:

> Cuando algo no puede procesarse con garantías, **se omite en lugar de arriesgarse**: una consulta que el
> normalizador no entiende viaja solo como hash y clase; un mensaje de error que no encaja en los formatos
> conocidos viaja solo como tipo y firma, **sin texto**.

El ADR 0083 añadió las firmas de error y **siempre mandaba el mensaje saneado**. Hasta aquí el producto se
comportaba al revés de su propia regla: emitía lo que sobreviviera.

La mitad de las consultas necesita un campo nuevo en el protocolo y va al gh-344, cloud primero.

## Decisión

**1. «No encaja» se mide por lo que queda, no por un catálogo.** No hay una lista de formatos conocidos que
comprobar, y no hace falta: el saneo del ADR 0083 es ansioso a propósito, así que **cuánto sentido sobrevive**
ya es la señal. Un mensaje que sale mayormente `?` no le dice nada a nadie y lo único que hace es arriesgar lo
que los patrones no cazaron.

**2. Se cuenta en palabras y no en caracteres.** Un `?` es un carácter y la palabra que sustituyó eran diez,
así que contar caracteres declararía significativo un mensaje justo cuando más ha perdido. Se cuenta qué
proporción de las palabras conserva alguna letra.

**3. El umbral es la mitad, y se elige generoso hacia omitir**, porque ése es literalmente el criterio del
producto. Cualquier número aquí es discutible; el sesgo no.

**4. Se omite el mensaje, no la firma.** Tipo y firma del stack siguen viajando, que es lo que
`product.md:104` dice y lo que mantiene la identidad agrupable: dos errores omitidos en el mismo sitio siguen
siendo el mismo error.

**5. Y se dice.** El texto queda como `Tipo: (message omitted: nothing recognisable survived sanitising)`. Un
texto que falta sin explicación es la clase de silencio que este producto no practica, y decirlo dentro del
propio texto es la única vía sin tocar el protocolo — que aquí sería desproporcionado.

## Alternativas

**Un catálogo de formatos conocidos.** Es la lectura literal de `product.md` y es una lista que se queda
corta el primer día: los mensajes de error de una aplicación no son un conjunto enumerable.

**Contar caracteres.** Arriba, decisión 2.

**Omitir en silencio.** Más simple y deja al lector con un hueco que no sabe interpretar.

**Un campo en el protocolo para «omitido por precaución».** Es lo correcto para las consultas, donde hay que
distinguirlo de la supresión que el usuario elige (gh-216), y aquí sería un campo nuevo para una frase.

## Consecuencias

- **Extiende al ADR 0083**, que dejó esto sin hacer.
- El hash sigue siendo del texto, así que un mensaje omitido y otro omitido en el mismo sitio agrupan. Lo que
  cambia es que dejan de agrupar con la versión no omitida del mismo error, y es correcto: son dos cosas
  distintas de decir.
- La mitad de las consultas sigue pendiente (gh-344), y hasta entonces el normalizador emite lo que no
  entiende. Está dicho ahí y no aquí.
