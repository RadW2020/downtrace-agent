# ADR 0021 — Cada ronda del benchmark empieza en el mismo estado

Estado: aceptado · Fecha: 2026-09-07 · Supera del ADR 0003 la suposición de que las rondas alternas bastan para hacer comparables dos variantes · Alcance: público

## Contexto

El ADR 0020 midió cuatro veces el overhead del agente en la máquina propia y dejó escrito que la línea de 1 ms del
p99 no la verifica nadie. El ruido que informaba el gate no era azar: era la dispersión de las rondas baseline, y
esa dispersión crecía con el número de ronda. Reproducible en dos ejecuciones independientes, el Δ por ronda
arrancaba en ~0 y acababa en +3,26 y +3,27 ms, con el p99 de la baseline subiendo 22,7 → 25,8 ms en paralelo.

La causa estaba en el código, no en la máquina. Cada ronda arranca la app en un proceso nuevo y cada job estrena
contenedores de Postgres y Redis, pero **entre rondas la base de datos es la misma y solo crece**: `migrate()` hace
`CREATE TABLE IF NOT EXISTS` y un seed con `ON CONFLICT DO NOTHING`, y nada vacía `orders`, `order_items`,
`payments` ni `order_events`. Una ejecución completa acumula unos 21.600 pedidos.

Eso rompe el método por dos sitios. Las rondas dejan de ser comparables entre sí, que es lo único que permite
restarlas; y como el orden es baseline→agente, **a la ronda del agente le toca siempre la base de datos más grande
de su par**, así que el estimador está sesgado en contra justo de lo que se quiere medir. Las rondas alternas del
ADR 0003 reparten el ruido aleatorio de la máquina; una deriva monótona no se reparte.

## Decisión

**Antes de calentar, cada variante de cada ronda vuelve a un tamaño de base de datos conocido.** La app de
referencia expone `POST /__admin/db/reset`, que vacía las tablas que escribe una request y repone el stock; el
catálogo sobrevive, porque la app lo necesita y el seed solo lo completa.

**Lo hace la app, no el benchmark.** `packages/bench` no tiene dependencias **externas** —solo hermanas del
workspace, y hoy una: la app de referencia, como dependencia de desarrollo— y esa propiedad se conserva: quien
conoce el esquema es quien lo vacía, y el harness solo llama a un endpoint que ya existía en la misma superficie de
administración que usa para muestrear CPU y memoria.

**Un reinicio que falla aborta la medición.** Saltárselo en silencio devolvería exactamente la clase de fallo que
esta decisión arregla: rondas que no son comparables y nada que lo diga.

**El presupuesto no se toca.** Lo que cambia es el estado que ve la medida, no la vara.

## Lo que esto significa para el presupuesto

Que el invariante 3 se mide **sobre una base de datos de tamaño conocido y pequeño**, no sobre una cualquiera. Es
menos realista que una base de datos grande y es la única forma de que dos números se puedan restar. Si algún día
importa el régimen contrario —cuánto cuesta el agente cuando las tablas son grandes—, eso es un experimento
distinto, con la base de datos sembrada a un tamaño fijo, no la consecuencia accidental de que la ronda 9 llegue
más tarde que la 1.

## Alternativas descartadas

- **Contrapesar el orden (B/A/A/B).** Cancela una deriva lineal sin saber de dónde viene, y es barato. Pero deja
  las rondas midiendo estados distintos: esconde el sesgo en vez de quitarlo, y el ruido informado seguiría siendo
  la deriva. Queda disponible si tras esto la dispersión entre rondas sigue creciendo.
- **Detendenciar el estimador**, comparando cada ronda del agente con la interpolación de las baselines que la
  rodean. Corrige la aritmética y no la medida; y añade una capa que hay que explicar cada vez que alguien lea la
  tabla.
- **Reiniciar los contenedores de Postgres y Redis entre rondas.** Igual de correcto y mucho más lento, y mete en
  la medida el arranque de dos contenedores.
- **Sembrar una base de datos grande y fija.** Mide el régimen que interesa a un usuario con datos, pero cambia la
  línea base otra vez y no es lo que el presupuesto dice hoy. Es el experimento del párrafo anterior, no esta
  decisión.
- **Aceptar la deriva y subir muestras.** Se probó en el ADR 0020: 9× muestras y la dispersión subió. Contra una
  deriva, alargar acumula más de lo que promedia.

## Lo que midió, después

Esta decisión se escribió antes de poder comprobarla. Medido en la misma máquina, con la misma configuración, y con
la repetición que descartó una primera ejecución en la que la ronda 9 se desplomó por carga ajena:

| | Δ p99 | Ruido | Ronda 1 → ronda 9 |
|---|---:|---:|---|
| Antes, 1ª | +1,178 ms | 2,935 | +0,21 → **+3,26** |
| Antes, 2ª | +1,526 ms | 3,122 | −0,03 → **+3,27** |
| Antes, 3ª (en `main`) | +1,244 ms | 2,677 | — |
| **Después** | **+1,045 ms** | **1,412** | +0,49 → **+0,65** |

La deriva desaparece: el Δ de la última ronda deja de ser cinco veces el de la primera. Y **el ruido se reduce a la
mitad**, porque ese ruido *era* la deriva: el estimador informaba de la dispersión de las rondas baseline, y las
rondas baseline se dispersaban porque cada una medía una base de datos más grande.

Lo que **no** arregla, y hay que decirlo: el veredicto sigue siendo `inconclusive`. Con Δ +1,045 y ruido 1,412, la
máquina todavía no resuelve el presupuesto de 1 ms. El ruido ha pasado de ser tres veces el presupuesto a 1,4 veces,
y el Δ es ahora un número estable en vez de uno que iba de 0 a +3,3 dentro de la misma ejecución. Eso convierte una
medida que no se podía discutir en una que sí: **el agente añade en torno a 1 ms en p99 en la arquitectura en la que
corre producción**, y el presupuesto es 1 ms. Lo que queda por decidir con ese dato no es de esta decisión.

## Consecuencias

- Las rondas vuelven a ser comparables por construcción, que es lo que el método necesitaba desde el principio.
- La app de referencia gana una operación de administración que solo tiene sentido para medir; está detrás de
  `ADMIN_ENABLED`, como el resto.
- El benchmark tarda un poco más: un `TRUNCATE` y un `UPDATE` por variante y ronda.
- El ADR 0003 mantiene todo lo demás; lo superado es dar por hecho que alternar rondas basta para que dos variantes
  vean lo mismo.
