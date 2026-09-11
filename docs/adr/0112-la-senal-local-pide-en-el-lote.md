# ADR 0112 — La instrumentación pide una captura en el lote, y la huella de una señal de proceso es el disparador

Estado: aceptado · Fecha: 2026-09-11 · Alcance: público

## Contexto

El canal de control iba en una sola dirección: el cloud pedía capturas y la instrumentación obedecía
(ADR 0071, 0098, 0073). El único origen vivo era *pedida*, por una persona. Los otros dos estaban
reservados en la tabla desde el principio y nadie los escribía.

`product.md:124` reparte el trabajo al revés de como estaba: la instrumentación «dispara por señales
locales». Y tiene la información: un proceso cuyo event loop va tarde lo sabe mucho antes de que ningún
agregado cruce la red, y para cuando el cloud pudiera notarlo el detalle que lo explicaría está
sobrescrito. El registro fino guarda decenas de segundos.

## Decisión

**La petición viaja en el lote y la orden vuelve en la respuesta.** El mismo canal del ADR 0071, ahora
en las dos direcciones. Una ruta propia serían una llamada más por disparo y una autenticación más para
un hecho que cabe en el lote que ya sale cada diez segundos. El precio es un intervalo de latencia, y no
se paga en detalle: la captura adjunta lo que el registro todavía retiene, que es justo para lo que
existe la cobertura *adjunta*.

**La señal es el retraso del event loop, p99 del intervalo, por encima de 250 ms durante dos intervalos
seguidos.** Un proceso sano vive en milisegundos de un dígito; uno a 250 ms es uno donde una request que
llega espera eso antes de que le pase nada. Dos intervalos porque `product.md:114` pide **sostenido**, y
un intervalo malo entre dos buenos es un pico. Un intervalo bueno reinicia la cuenta.

**La huella de una señal de proceso es el entorno y el disparador, sin ruta.** El event loop no es de
ninguna ruta, y nombrar la más ocupada sería atribuirle un problema que nadie ha medido (ATR-01). Eso
obliga a que el disparador sea una columna de la huella, que es lo que `product.md:122` ya decía —«se
deduplican por huella (endpoint, **tipo de disparador**, dependencia implicada)»— y que hasta ahora
sobraba porque todas las capturas las pedía una persona.

**Un rechazo es silencio.** No hay canal para decirle que no a una instrumentación y no haría nada
distinto con la negativa. La orden que no recibe es la respuesta, y el presupuesto —el mismo para las
tres procedencias— lo sigue decidiendo el cloud, que es el único que ve el proyecto entero.

**El enfriamiento es local además de remoto.** El del cloud es por huella y ya existe; el local evita la
pregunta: una señal que dura diez minutos preguntaría sesenta veces, y el lote llevaría una petición que
ya se sabe rechazada.

## Alternativas

**Una ruta propia, `POST /v0/captures` con el token de ingesta.** Más directa y más cara: una llamada, un
camino y una autenticación más, y un segundo sitio donde el presupuesto podría comprobarse distinto. El
argumento es el mismo del ADR 0071, y vale igual en esta dirección.

**Que la instrumentación capture sin preguntar y mande la evidencia con un identificador suyo.** Se salta
el presupuesto, que es lo único que impide que un proyecto con mil instancias se inunde a sí mismo, y
obliga al cloud a aceptar identificadores que no ha emitido.

**Umbral relativo a la historia del propio proceso.** Es un detector, y los detectores son del cloud
(`product.md:124`). Un umbral absoluto es lo que `product.md:114` reserva para lo local, precisamente
porque no necesita historia.

**Nombrar la ruta más ocupada en la huella.** Daría una captura filtrada y más barata, y estaría
atribuyendo una saturación a la ruta que más tráfico tenía, que es la falacia que ATR-01 existe para
impedir.

## Consecuencias

- CAP-01 sale de la lista de compromisos sin cubrir: 21 de 24. La cláusula que faltaba —«una captura
  solicitada compite por el mismo presupuesto que las automáticas»— tiene ahora las dos mitades y un test
  en el store que las hace competir.
- Una captura automática es de entorno, así que su evidencia es el registro entero. Es lo que se quiere
  cuando el event loop está bloqueado: lo interesante es el proceso, no una ruta. Está acotada por el
  presupuesto de evidencia, que ya existía.
- La ventana de una automática es de 30 s y caduca a los 2 min: lo justo para que una instrumentación que
  vacía cada diez segundos la recoja y conteste, sin que un proceso que murió retenga un hueco.
- Las otras dos señales de `product.md:114` quedan pendientes, y su decisión no es el umbral sino la
  huella: una espera de pool sí nombra una dependencia.
- El prearmado sigue sin existir (gh-406). Esto captura cuando algo pasa; prearmar es subir el detalle
  **antes**, y todavía no hay nivel que subir.
