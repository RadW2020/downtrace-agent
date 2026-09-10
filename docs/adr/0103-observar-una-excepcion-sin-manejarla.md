# ADR 0103 — Observar una excepción no es manejarla, y la diferencia se mide

Estado: aceptado · Fecha: 2026-09-10 · Alcance: público

## Contexto

`product.md:77` pide observar «errores **y excepciones**». El cloud ya sabe recibirlas (ADR 0102); faltaba
observarlas, y es la única observación de este producto que puede **cambiar lo que la aplicación habría
hecho**: en Node, registrar un oyente de `uncaughtException` *maneja* la excepción, y una excepción
manejada no mata el proceso.

Medido antes de escribir nada, con tres procesos que lanzan el mismo error desde un temporizador:

| variante | código de salida | salida de error |
|---|---|---|
| sin oyente | **1** | la traza, 10 líneas |
| `process.on("uncaughtException", () => {})` | **0** | **nada** |
| un oyente que vuelve a lanzar | **7** | la traza |

El oyente normal es lo peor que podría pasarle a un usuario: un proceso que tenía que morir **sobrevive y
sale con éxito**, en silencio, con el estado que sea. Y volver a lanzar tampoco sirve: 7 no es 1, y el
supervisor que reinicia por código de salida vería otra cosa.

## Decisión

**`process.on("uncaughtExceptionMonitor", …)` y nada más.** Node lo llama **antes** de los oyentes reales y
**no cuenta como manejar** la excepción. Medido: mismo código de salida y misma traza que sin instrumentar,
para las dos clases.

Y su segundo argumento, `origin`, distingue `uncaughtException` de `unhandledRejection`, así que **una sola
suscripción** cubre las dos y no hay dos caminos que puedan desincronizarse.

## Lo que se pierde, dicho y no prometido

**Si el proceso muere, la excepción se pierde.** El vaciado es asíncrono, una excepción no capturada no pasa
por `beforeExit`, y no hay canal síncrono con el que mandarla. Prometer lo contrario sería mentir.

Llega cuando la aplicación **sobrevive**: tiene su propio `uncaughtException` —un patrón común, registrar y
seguir— o fue una promesa rechazada que su política no mata. Ese caso es real y frecuente, y es donde esto
vale algo. El README lo dice con esas palabras.

## Alternativas

**`process.on("exit")`.** Corre síncronamente al final y no recibe el error, sólo el código. Sabría que algo
pasó y no qué.

**Escuchar y volver a lanzar.** Medido arriba: 7 en vez de 1.

**No observarlas.** Es lo que había, y deja invisible la forma más grave en que una aplicación falla.

## Consecuencias

- **El test es dos procesos**, uno instrumentado y otro no, lanzando lo mismo, y compara código de salida y
  salida de error. Es un guardián de regresión: pasaba antes de escribir la implementación, y su valor está
  en que **falla con las dos formas equivocadas** —con el oyente normal da 0, con el que relanza da 7—, lo
  cual se comprobó antes de confiar en él.
- Las firmas se cuentan por firma y no por ocurrencia (ADR 0102), y dos lanzamientos **desde el mismo sitio**
  son una firma con conteo dos: el stack es lo que las distingue, así que dos `throw` en dos líneas son dos
  cosas distintas, y con razón.
- Un lote que sólo lleva excepciones **se manda**. Al implementarlo, el emisor volvió a preguntarse «¿hay un
  intervalo, un perfil o un informe de captura?» y la respuesta fue no. **Es la tercera vez** que esa lista
  se queda corta al añadir algo al lote (gh-375, gh-379, y ésta). Ahora es una pregunta —`hasSomethingToSay`—
  y no una lista, que es lo que el ADR 0099 dijo que había que hacer y no se hizo hasta ahora.
