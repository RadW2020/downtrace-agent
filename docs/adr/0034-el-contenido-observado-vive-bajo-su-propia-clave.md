# ADR 0034 — El contenido observado vive bajo su propia clave

Estado: aceptado · Fecha: 2026-09-08 · Alcance: público

## Contexto

Con el perfil de huellas legible (gh-216), la API de Downtrace empieza a devolver **texto escrito por el backend
del usuario**: el texto normalizado de sus consultas. Hasta ahora lo que salía era acotado —plantillas de ruta,
hosts de dependencia, cadenas de versión— y viajaba mezclado con la prosa que escribimos nosotros, dentro de
campos como `headline` o la frase de un aviso.

El invariante 12 exige que se distingan. Y la razón no es de forma:

- **Para un agente de programación** (ADR 0016), no poder separar el dato observado del juicio nuestro es la
  diferencia entre citar una evidencia y citarnos a nosotros.
- **Para la confianza**, porque el texto observado es el que puede llevar algo que no debería haber salido. Si
  está marcado, se puede auditar, filtrar y suprimir **en un solo sitio**. Si va embebido en prosa, no.

El gh-204 recoge la deuda de los campos que ya existen. Este ADR decide la convención con la que nacen los nuevos.

## Decisión

**Lo que viene del servicio del usuario vive bajo una clave `observed`, y nada de lo que escribe Downtrace vive
ahí dentro.**

```json
{
  "kind": "query",
  "hash": "e466c1383c8d9df6",
  "label": "sent",
  "executions": 1204,
  "observed": { "text": "SELECT id FROM products WHERE id = ?" }
}
```

Separar por **estructura** y no por anotación tiene una consecuencia que es la que se buscaba: encontrar todo el
contenido de usuario en una respuesta es recorrer el JSON y quedarse con lo que cuelga de `observed`. Sin
heurísticas sobre el texto, sin lista de rutas de campo que mantener al día, y sin que un campo nuevo se cuele por
olvido — porque el olvido consistiría en **no** ponerlo bajo `observed`, y entonces no lleva contenido de usuario
por construcción, o el test lo caza.

**Y la ausencia de un dato observado tiene tres respuestas, no una.** Un `label` dice cuál:

- `sent`: el texto está, y está bajo `observed`.
- `suppressed`: quien envía puso `DOWNTRACE_QUERY_TEXT=off`. Es una elección suya y se respeta diciéndola.
- `notApplicable`: es el cajón `(other)`, que agrupa muchas huellas y **no tiene** un texto único.

Llamar «suprimido» al cajón sería culpar al emisor de algo inherente a la forma del dato, y dejar los tres casos
como un campo vacío sería la confusión que este producto no comete.

## Alternativas

**Marcar dentro del texto**, con delimitadores o con un tipo envolvente por valor. Conserva las frases tal cual y
obliga a quien consume a parsear para separar, que es exactamente la heurística sobre el texto que se quería
evitar.

**Una lista de rutas de campo observadas** en la cabecera de la respuesta. Se desincroniza al primer campo nuevo,
y el desincronizado no se nota: la lista sigue siendo válida, solo que incompleta.

**Reescribir la prosa para que nunca embeba nada.** Funciona para `headline`, que ya solo traduce un disparador a
palabras, y no para la frase de un aviso, que existe para que una persona la lea en Slack y necesariamente nombra
la ruta y la dependencia. Un producto que se niega a escribir esa frase no tiene aviso.

**Dejarlo para el gh-204 y no marcar lo nuevo.** Habría sido lo barato hoy y lo caro después: la convención en un
campo que nace cuesta una clave; en un campo publicado cuesta romper el contrato que el ADR 0022 fijó.

## Consecuencias

- Hay un test que recorre la respuesta y **falla si el texto observado aparece fuera de `observed`**. Es lo que
  impide que esto se erosione al añadir el siguiente campo, que es como se erosionan estas cosas.
- El gh-204 hereda una convención en vez de tener que inventarla, y su trabajo pasa a ser mover los campos que ya
  existen sin romper a quien los consume — que sigue siendo una decisión suya, no de este ADR.
- Un consumidor que quiera no ver nunca contenido de usuario puede quitar `observed` de la respuesta entera y lo
  que queda sigue siendo coherente: la identidad de una huella es su hash, no su texto (ADR 0017).
