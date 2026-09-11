# ADR 0116 — Una estimación no se publica como el conteo de afectadas

Estado: aceptado · Fecha: 2026-09-11 · Alcance: público

## Contexto

El informe declaraba desconocido el conteo de requests dañadas, con esta razón: los agregados no llevan
detalle por request. Fue cierta hasta el gh-398: desde entonces la evidencia de una captura trae las
requests con sus operaciones, filtrada por la huella que se pidió y con sus dos coberturas.

IMP-01 (`product.md:112`) dice qué se puede hacer con eso, y la parte difícil no es contar:

> Solo llama *afectadas* a las requests que cumplen un criterio de degradación explícito y cuyo conteo
> puede sostener con la evidencia disponible; **publica ese criterio, su denominador y la cobertura** (…)
> Si el conteo procede de una muestra o de una aproximación, **se presenta como estimación con su método
> y límites**; si no puede estimarse, queda desconocido.

## Decisión

**`affected` sigue siendo nulo, siempre.** Lo que se añade es un campo distinto, `estimate`, porque es
una afirmación distinta: las requests capturadas son las que el registro fino retenía cuando se congeló,
una muestra de la ventana y no la ventana. Meter el número en `affected` sería exactamente lo que IMP-01
prohíbe, y el campo nulo con su motivo es lo que hoy mantiene esa promesa.

**El criterio es el del disparador que abrió el hallazgo.** Para una multiplicación de operaciones, una
request cuenta si ejecutó **más operaciones que el techo de la referencia congelada** —el mismo número
que hizo saltar al detector, leído request a request en vez de en un histograma—. No se inventa un
criterio para la ocasión: se aplica el que ya decidió que aquí pasaba algo.

**Lo que no se puede juzgar no se juzga.** Una request cuyo detalle se sobrescribió o se truncó sale del
denominador y se cuenta aparte. Contarla como sana convertiría un hueco en un hecho (invariante 14), y
contarla como dañada sería inventar. El denominador y los no juzgados viajan los dos, porque un
denominador que encoge en silencio es una proporción que crece en silencio.

**El denominador sale de la evidencia, nunca del tráfico agregado.** Son poblaciones distintas —una es
lo que se capturó, otra lo que ocurrió— y dividir una entre otra produce una proporción que no significa
nada.

**Solo donde el detalle lo sostiene.** El registro fino guarda **operaciones**, que son consultas, y no
llamadas a Redis ni HTTP saliente. Un hallazgo de composición sobre esas dependencias sigue desconocido,
con ese motivo escrito. Y los otros cuatro disparadores tienen sus propios criterios, que no existen
todavía.

**Una captura se ata a un hallazgo por huella y ventana**, no por una relación guardada: nadie captura
*para* un hallazgo —lo pide una persona o una señal local— así que lo que hay es «este detalle es sobre
lo mismo, al mismo tiempo», y decir más sería inventar una intención.

## Alternativas

**Publicar el conteo en `affected` cuando hay captura.** Es la lectura que IMP-01 prohíbe y la que un
lector haría por defecto: el número saldría en un informe con el nombre que el producto reserva para un
conteo sostenible, sobre una muestra que no lo sostiene.

**Extrapolar de la muestra a la ventana.** Multiplicar por el tráfico agregado da un número grande y
redondo que nadie midió. IMP-01 admite estimaciones **con su método y sus límites**, y el método
«regla de tres sobre poblaciones que no sabemos si son comparables» no es uno.

**Contar como sanas las requests sin detalle.** Aumenta el denominador y baja la proporción, que es
precisamente la dirección cómoda.

**Un criterio propio, como «tardó más que el p95 de la referencia».** Necesita una distribución de
referencia comparable —las muestras del gh-307— y decidir qué percentil, que es producto. El criterio
del disparador ya está decidido y ya está publicado.

## Consecuencias

- IMP-01 deja de estar completamente sin cumplir: hay un camino, estrecho y honesto, para decir cuántas
  requests capturadas se comportaron mal, con su criterio al lado.
- El motivo del desconocido pasa a decir lo que falta **hoy** —no hay captura que cubra esta ventana— en
  vez de lo que faltaba antes de que las capturas existieran.
- La palabra «afectadas» sigue sin aparecer en ninguna frase que Downtrace escriba. Hay un test que
  recorre cada respuesta y falla si aparece, y encontró dos redacciones mías mientras se escribía esto.
- ESC-03 —varios hallazgos que comparten requests— sigue pendiente: esto estima por hallazgo, y sumar
  dos estimaciones seguiría estando prohibido.
