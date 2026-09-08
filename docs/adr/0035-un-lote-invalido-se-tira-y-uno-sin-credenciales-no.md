# ADR 0035 — Un lote inválido se tira; uno rechazado por credenciales, no

Estado: aceptado · Fecha: 2026-09-08 · Alcance: público

## Contexto

`Sender.flush` trataba igual todos los fallos del cloud: si la respuesta no era `ok`, el lote se quedaba en cola y
se reintentaba en el siguiente vuelo. Correcto para un 500 o un corte de red. Para dos casos, no.

Un **400** dice que el lote está mal, y estará igual de mal mañana. Reintentarlo ocupaba uno de los seis huecos de
la cola —**desplazando lotes que sí eran válidos**— y gastaba una petición por intervalo en algo que no podía
funcionar. Y no se distinguía de nada: `failed` subía igual que con el cloud caído, que es el problema opuesto y
con la solución opuesta. El de un lote inválido es además un fallo **nuestro**, que es justo el que hay que ver.

Un **429** viene con `Retry-After`, y se ignoraba. El cloud lo manda en dos casos: al pasarse del límite por
minuto, y al agotar el presupuesto diario, donde el valor son los segundos hasta el próximo día UTC.

## Decisión

**400, 413 y 422 descartan el lote y se cuentan aparte. 401 y 403 lo conservan.**

La diferencia no es de familia de código, es de a quién apunta el error. «Este lote está mal» es definitivo: se
tira. «Tú estás mal» es temporal: cuando el operador arregle el token, los seis intervalos que quedan en cola
valen, y tirarlos habría perdido datos recuperables. Copiar el comportamiento de uno al otro habría perdido datos
buenos o guardado datos inservibles, según cuál se copiara.

Se avisa **una vez** de que el agente está produciendo algo que su cloud no acepta. Una vez, como el 401:
repetirlo cada intervalo sería su propio problema.

**`AgentStats` gana `rejected`**, distinto de `failed` —falló la red o el cloud— y de `dropped` —la cola estaba
llena—. Tres cosas distintas que se veían como una.

**El `Retry-After` se obedece, con un tope de 24 horas.**

Veinticuatro y no cinco minutos: el valor legítimo más grande que manda el cloud son los segundos hasta el
próximo día UTC, y recortarlo a minutos sería volver a pelearse con el limitador todo el día, que es lo que se
venía a arreglar. **El tope existe para que un valor absurdo no calle la instrumentación para siempre, no para
desobedecer al cloud.** Un valor ausente, negativo o ilegible se trata como ausente: una cabecera que no se puede
leer no es una instrucción.

**Durante la espera se sigue agregando.** La cola sigue acotada y sigue tirando lo más viejo pasados seis, igual
que ante un cloud caído. Dejar de medir porque no se puede enviar sería perder también lo que sí se podrá.

## Alternativas

**Tirar también en 401.** El mensaje que ya había —«aggregates will be dropped until it is fixed»— sugería eso, y
era cierto solo de rebote, porque la cola acababa expulsándolos. Descartada: convierte un problema de
configuración de diez minutos en una pérdida de datos garantizada.

**Reintentar el 400 unas cuantas veces por si acaso.** Descartada: un esquema no se vuelve válido por insistir. Lo
que hay que hacer con un lote inválido es verlo, y para eso está el contador y el aviso.

**Retroceso exponencial para los 5xx.** Sería lo siguiente si hiciera falta, y hoy no: el intervalo de diez
segundos ya espacia los intentos, y la cola acotada ya limita el daño.

**Autodesactivarse tras varios lotes rechazados**, como se hace con diez errores internos. El contador está y esa
decisión se puede tomar cuando haya un caso real; hacerlo ahora sería inventar un umbral sin datos.

## Consecuencias

- Un lote inválido deja de robarle el sitio a los buenos, que era el daño concreto.
- `rejected` distingue un fallo nuestro de uno del cloud, y eso cambia qué mira quien depura.
- Un proyecto que agota su presupuesto diario deja de golpear al cloud hasta medianoche. Sus datos de ese día se
  pierden igual —el cloud no los aceptaría— pero se pierden sin hacer ruido.
- Queda una asimetría deliberada: un 429 sin `Retry-After` legible se comporta como antes. Si algún día el cloud
  deja de mandar la cabecera, el agente volverá a insistir, y eso se notará en el cloud antes que en el agente.
