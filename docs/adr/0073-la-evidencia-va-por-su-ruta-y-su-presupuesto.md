# ADR 0073 — La evidencia va por su ruta, con su presupuesto, y decide cómo acaba la captura

Estado: aceptado · Fecha: 2026-09-10 · Alcance: público

## Contexto (gh-322)

Con el ADR 0070 una captura tiene ciclo de vida y con el 0071 la instrumentación se entera de que existe.
Falta lo que le da sentido: que la evidencia llegue y la captura termine en algo que no sea `expired`. Hoy
todas caducan.

Es la última mitad cloud. El **ADR 0008** manda que el cloud acepte antes de que el emisor mande, así que esto
va antes que el gh-277.

## Decisión

**1. Su propia ruta.** `POST /v0/captures/{id}/evidence`, no un campo del lote. Un lote es lo que sale cada
diez segundos; una captura es un suceso raro y varios órdenes de magnitud mayor. Compartir cuerpo obligaría al
camino caliente a cargar con el tope del caso raro: ocho mebibytes de límite en cada intervalo, cuando un lote
cabe en uno.

Se autentica con el **token de ingesta**, no con una credencial de operación: manda la instrumentación, no un
operador. Y comparte el cubo del limitador con los lotes, que es correcto porque una captura es mucho más rara
que un intervalo y nunca compite con la telemetría real.

**2. Su propio presupuesto, contado en requests.** El invariante 8 acota **filas de agregados**. La evidencia
no son agregados, y hacerla competir por el mismo número le costaría a un proyecto su telemetría por haber
hecho una pregunta. Dos topes: uno por captura —el tamaño del anillo de requests del registro fino, porque
pedir de vuelta más de lo que la instrumentación puede guardar es pedir algo que no existe— y otro por
proyecto y día.

**3. La forma la fija lo que el registro fino ya produce** (ADR 0068): requests con su instante absoluto, su
duración, método, ruta y estado; operaciones con `hash`, `startMs` y `endMs` **relativos a su propia request**.
Inicios y fines y no duraciones, porque la razón entera de capturar detalle es el **orden y el solapamiento**,
que una duración no expresa.

**Huellas, nunca texto.** El perfil es donde quien envía elige si manda el texto de sus consultas; esta ruta no
lo lleva nunca, y `additionalProperties: false` lo convierte en un rechazo y no en una costumbre (invariante 5,
ADR 0017). Un test comprueba que la palabra `text` no aparece en ninguna parte del contrato.

**4. Dos coberturas, dos números, y una frase que dice que no se suman.** `product.md:192` pide declarar ambas:
lo adjuntado del detalle previo todavía retenido y lo observado desde el inicio efectivo. Un total escondería
que la mitad es más vieja que la captura. Y viajan con `detailLost` y `truncated`, que son las dos maneras en
que el detalle puede faltar: una request sin operaciones se lee como una que no ejecutó nada, y decir cuál de
las dos cosas es no es opcional (invariante 14).

**5. El inicio efectivo llega con la evidencia**, no en una llamada aparte: una captura que empezó y no llegó a
terminar no tiene por qué costar dos peticiones. Con varias instancias respondiendo —el ADR 0071 decidió que
todas reciban la misma orden— la captura empezó cuando empezó **la primera**, así que se guarda el menor.

**6. Cómo acaba lo decide lo que llegó, no quien llama.** Sin requests, `empty`. Con detalle perdido o
truncado, `partial`. Lo demás, `complete`. Y `empty` **no es un fallo**: la entrega se acepta con 202 y el
motivo dice qué significa —«una captura sin requests no dice nada sobre si el problema se ha ido»— sin la
palabra «recuperado» y sin invitar a repetir lo mismo. Un test prohíbe cinco palabras en ese motivo.

Evidencia de una captura ya terminada o caducada es un 409 que dice dónde acabó, sin mutar: el estado no
retrocede (ADR 0070).

## Alternativas

**Meter la evidencia en el lote.** Arriba, decisión 1.

**Que compita por el presupuesto de filas del invariante 8.** Es lo simple y es lo que castiga preguntar.

**Guardar las requests en tablas** —una por request y otra por operación— en vez de un documento JSONB. Nada
consulta dentro de esto todavía: el análisis que lo hará es ATR-01 e IMP-01, cada uno su tiquet. Inventar la
forma de una consulta que nadie escribe es como un esquema se equivoca dos veces.

**Una fila por captura en vez de por entrega.** Varias instancias responden a la misma orden a propósito
(ADR 0071); juntarlas al guardar perdería de qué proceso vino cada cosa, y una ruta servida por cuatro pods se
comporta distinto en cada uno. Se guardan todas, con una clave única por `(captura, instancia)` para que un
reintento no cuente dos veces. Ordenarlas en una sola línea temporal es análisis.

## Consecuencias

- Protocolo **0.7.0** otra vez, la misma minor sin publicar: `capture-evidence.schema.json`, sus fixtures, y
  `CAPTURE_EVIDENCE_PATH` generado en los dos lenguajes —una ruta escrita a mano en un lado es un 404 el día
  que el otro la mueve—.
- El enum de versiones vive **solo** en el esquema del lote; `make gen` falla si el de la evidencia difiere.
- La consulta de una captura devuelve la evidencia; la lista no, porque llevaría cada request de cada captura.
- Las requests capturadas viven bajo `fromService`: cada ruta que hay dentro es del servicio, y un consumidor
  tiene que poder encontrar contenido del usuario recorriendo y no conociendo la forma (ADR 0036).
- El guardián de operaciones del gh-318 exige que esta ruta esté en su lista de la superficie de ingesta **con
  la razón escrita** de por qué es idempotente sin pasar por la puerta. Lo está: la clave única y el estado que
  no retrocede.
- **CAP-01 y ESC-08 siguen en la deuda hasta el gh-277**: nada produce esto todavía, que es exactamente la
  forma que el ADR 0008 impone.
