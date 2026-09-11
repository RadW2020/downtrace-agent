# ADR 0106 — El contrato manda sobre el parser, y el parser se prueba con los fixtures publicados

Estado: aceptado · Fecha: 2026-09-11 · Alcance: público

## Contexto

El canal de control existe desde el ADR 0071: la orden de captura viaja en la respuesta del ingest. El
esquema declara el plazo como una fecha —`expiresAt`, `"format": "date-time"`— y el cloud la escribe como
tal, porque la generación de tipos convierte ese formato en `time.Time`. La instrumentación exigía un
número:

```ts
if (typeof c.windowSeconds !== "number" || typeof c.expiresAt !== "number") continue;
```

`continue`. Ninguna orden del cloud real llegó a empezar nunca. Los dos extremos estaban implementados y
lo que fallaba era el contrato entre ellos, que ninguna prueba cruzaba: los tests del parser construían el
cuerpo a mano, con números, así que comprobaban el parser contra sí mismo.

## Decisión

**La forma del contrato es la forma canónica, y se convierte en la frontera.** El instante llega como
cadena RFC 3339 y se convierte a milisegundos en `capturesIn`, que es el único sitio donde entra. Dentro
del proceso todo sigue contando en milisegundos.

**No se aceptan las dos formas.** Tragarse también el número que el cloud nunca emitió conservaría este
error como comportamiento, y el día que alguien mande un número sería imposible saber si es un cliente
antiguo o un bug nuevo.

**Un parser de un contrato se prueba con los fixtures publicados de ese contrato.** Están en
`packages/protocol/schema/v0/fixtures/`, se enumeran desde el directorio y ya los valida el propio
esquema. Un cuerpo escrito a mano en el test solo comprueba lo que quien lo escribió creía que decía el
contrato, que es exactamente lo que falló aquí.

## Alternativas

**Aceptar número y cadena.** Barato hoy, y convierte un error en una variante del protocolo que hay que
mantener para siempre.

**Declarar el plazo como número en el esquema.** Cambiaría el contrato para que se pareciese al parser,
que es la dirección equivocada: una fecha en JSON es una cadena en todo lo demás del protocolo, y el
generador de Go produciría un `int64` donde hoy hay un `time.Time`.

**Dejarlo en un test de unidad.** El test de unidad es necesario y no es suficiente: lo que faltaba era
un recorrido que fuese del cloud a la instrumentación y volviera. Ahora el e2e pide una captura y espera
su evidencia.

## Consecuencias

- El e2e cubre el canal de control de extremo a extremo: orden, inicio efectivo y evidencia (CAP-01,
  ESC-08). Si la instrumentación vuelve a ignorar la respuesta, falla.
- Un plazo ilegible descarta **esa** orden y conserva las demás del mismo cuerpo: sigue valiendo que un
  cuerpo que no se entiende son cero órdenes y nunca un error (gh-379).
- La regla vale para el resto de instantes que el protocolo añada: se convierten en la frontera, una vez.
