# ADR 0085 — La clase de una consulta es la razón por la que no hay texto

Estado: aceptado · Fecha: 2026-09-10 · Alcance: público

## Contexto (gh-344)

`product.md:113`: «una consulta que el normalizador no entiende viaja solo como **hash y clase**». La clase no
existía, y sin ella omitir el texto de una consulta la vuelve indistinguible de una que el usuario suprimió a
propósito — que es exactamente la confusión que el gh-216 arregló dando tres respuestas a «por qué no hay
texto»: enviado, suprimido por quien envía, inaplicable.

Ésta es la mitad de protocolo y de cloud. Que el agente decida cuándo no entiende una consulta es el gh-347, y
va después porque el **ADR 0008** manda cloud primero y nunca en el mismo PR.

## Decisión

**1. `class` es un campo propio, no un valor especial de `text`.** Un texto que dice «select» es un texto, y
el guardián de contenido del servicio lo trataría como tal — con razón, porque no puede saber que esa palabra
la pusimos nosotros. Una clase es nuestra palabra y merece su campo.

**2. Su presencia es la razón.** No hace falta un campo «omitido por precaución» aparte: una operación con
clase y sin texto **es** eso. La cuarta respuesta del `label` se deriva, igual que las otras tres.

Y las dos juntas se rechazan en el esquema: son dos respuestas a la misma pregunta, y aceptarlas sería dejar
que el emisor diga dos cosas y que el lector elija.

**3. La clase la decide quien envía.** El cloud no ve la consulta original —ése es el punto— así que no puede
clasificar nada. Recibe lo que el emisor pudo decidir sin entenderla: su primera palabra clave.

## Alternativas

**Un `label` explícito en el protocolo.** Haría al emisor responsable de una palabra que el cloud ya deriva de
lo que hay, y dos fuentes para el mismo hecho envejecen distinto.

**Omitir el texto y ya.** Es lo barato y borra la distinción del gh-216: el lector no sabría si alguien eligió
callar o el producto no se fio.

**Que el cloud clasifique.** No tiene la consulta. Si la tuviera, no haría falta nada de esto.

## Consecuencias

- Protocolo **0.7.0**, la misma minor sin publicar. El esquema rechaza clase y texto juntos.
- El `label` tiene cuatro valores: `sent`, `suppressed`, **`omitted`** y `notApplicable`. Y la clase viaja con
  el cuarto, o `omitted` no diría de qué hablaba.
- **Un guardián que no guardaba.** El test se llama «rejects every invalid fixture» y solo comprobaba la lista
  escrita a mano: un fixture inválido nuevo no se comprobaba nunca. Ahora recorre todos. Es el mismo fallo que
  el gh-318 encontró en el enrutador, en otro sitio.
- Nada manda clases todavía, que es la forma que el ADR 0008 impone.
