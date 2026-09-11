# ADR 0113 — La instrumentación manda diferencias de lo que pierde, y el cloud las suma

Estado: aceptado · Fecha: 2026-09-11 · Alcance: público

## Contexto

`product.md:239` promete que la instrumentación «mide y envía sus propios recursos internos: memoria de
sus buffers, tiempo en sus hooks, lotes enviados, descartados y rechazados, evidencia perdida por
presupuesto. **Eso es lo que se ve en el estado del proyecto**».

Los medía —`AgentStats` los tenía todos— y no los mandaba. El punto ciego que eso deja es el peor que
este producto puede tener: **el cloud no podía distinguir «no ha pasado nada» de «la instrumentación
lleva dos horas tirando lotes»**. Es el invariante 14 en el sitio donde más caro sale, y es lo que le
faltaba a COB-02 para poder avisar de una pérdida sostenida de cobertura.

## Decisión

**Viajan las pérdidas y el coste, no el volumen.** Lotes descartados, rechazados y fallidos, errores
internos, lo que se ha soltado por coste, la memoria de los registros y el tiempo en los hooks. `sent` y
`recorded` se quedan fuera: el cloud ya cuenta lo que le llega, y un número que se deriva de lo recibido
no necesita viajar.

**Los contadores son diferencias desde el lote anterior, y el cloud las suma.** Un acumulado obligaría a
quien lee a restar y a saber cuándo arrancó el proceso; una diferencia se suma y ya. Y se conservan
cuando el lote no aterriza: **un contador que muere con su lote miente hacia abajo**, que es la dirección
peligrosa —hace que una instrumentación que está perdiendo datos parezca sana—.

**Ausente no es cero.** La regla que pusieron los observadores (ADR 0093): un emisor antiguo no manda
nada, y leer eso como «no se perdió nada» sería inventar exactamente la respuesta que esto existe para no
inventar. En el lote, el campo se omite cuando no hay nada que decir; en la base, las columnas son nulas
hasta que alguien dice algo; y en la página, «not reported (older instrumentation)» no se parece a
«nothing lost».

**Lo soltado no se recuerda.** Los contadores se acumulan; `shed` no. Soltar detalle termina cuando el
proceso se recupera, y conservar el último valor reportaría una pérdida que ya no ocurre.

**El tiempo en los hooks viaja nombrado como estimación.** Está muestreado, es lo que el invariante 3
presupuesta, y quien lo compare con ese presupuesto tiene que saber cómo se obtuvo. Se llama
`hookMsPerRequestEstimate` en la API por eso.

**Se guarda en `instances`, como los observadores.** Una fila por instancia, declarada por el emisor y
sin que el cloud la verifique (gh-220, ADR 0092). Lo que se pregunta es «cómo va esta instancia», no «cómo
iba hace una hora», así que no hace falta una serie temporal ni su retención.

## Alternativas

**Acumulados en vez de diferencias.** Obliga a quien lee a restar dos lecturas y a distinguir un
contador que se reinició de un proceso que volvió a arrancar. El resto del protocolo manda diferencias.

**Una tabla por intervalo, como la salud del runtime.** Una serie temporal con su rollup horario y su
retención, para responder una pregunta que es del presente. Cuando haga falta la historia, será su ADR.

**Mandar también `sent` y `recorded`.** Volumen que el cloud ya sabe: cuenta los lotes que recibe y las
filas que inserta. Dos fuentes para el mismo hecho es la definición de una que acabará mintiendo.

**Un campo con la profundidad de la cola.** Se descartó al escribirlo: la cola está acotada a lo que un
lote lleva, así que en el momento de enviar su profundidad es el tamaño del propio lote y no dice nada.
Lo que importa —que no se pudo enviar, que se descartó— ya está en los contadores.

## Consecuencias

- COB-02 puede completarse: la pérdida que el cloud ve deja de ser solo la que él mismo rechaza.
- COB-01 gana el tercer estado que le faltaba: conectada, activa, **y conectada descartando lotes**.
- El modo mínimo no toca nada de esto: son números y enums nuestros, no texto del servidor.
- La instrumentación no manda todavía la evidencia perdida por presupuesto, y no hace falta: la rechaza
  el cloud, que ya lo sabe sin que nadie se lo cuente.
