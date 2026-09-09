# ADR 0067 — El resumen grueso guarda sumas por segundo, y su presupuesto de memoria es aritmética comprobada

Estado: aceptado · Fecha: 2026-09-09 · Alcance: público

## Contexto

`product.md:91` describe dos registros en memoria y ninguno existía. Éste es el barato:

> *Resumen grueso*: los últimos minutos de agregados **por segundo** y por endpoint … es muy barato y permite ver **cómo empezó** algo que se detectó tarde.

Hasta ahora la granularidad mínima era el intervalo de agregación. Una degradación que arranca y se detecta dentro del mismo intervalo no tenía línea temporal: el cloud sabía que el minuto fue malo y no si se torció de golpe o en cuarenta segundos, que son dos problemas con dos causas.

Es la primera pieza de la caja negra, y se hace primero porque trae la maquinaria —presupuesto de memoria, registro circular, cobertura— con mucho menos riesgo contra el invariante 3 que la pieza cara.

## Decisión

**Sumas y un máximo por segundo, nunca percentiles.** Un histograma por segundo y por ruta multiplica la memoria por su número de cubos para responder a una pregunta que el intervalo ya responde con exactitud. El resumen grueso existe para ver **la forma de la curva**, no para medir un percentil de un segundo, que además tendría una muestra ridícula.

**Cada ruta reserva su fila la primera vez que se la ve, con tope.** Reservar las quinientas por adelantado son megabytes para una aplicación con tres rutas; crecer sin tope viola el invariante 1. Un `Float64Array` del tamaño de la ventana por ruta, hasta 128 filas, y el resto a un cajón que se cuenta. Ciento veintiocho y no quinientas: este registro existe para enseñar la forma de un cambio, y una ruta con una request cada varios minutos no tiene forma por segundo.

**Una ranura de una ventana anterior se limpia al escribirla, no en un barrido.** El coste se queda con la escritura que lo necesita en vez de pagarse una vez por segundo por todas las filas.

**Un segundo tranquilo son ceros; un segundo que nadie miró está ausente.** Es la diferencia que este producto no puede permitirse confundir: una ruta que se calla treinta segundos es como se ve un buen número de incidentes. Por eso cada fila recuerda **desde cuándo** existe, y no se inventan ceros anteriores a la primera vez que se vio la ruta — eso diría que estaba en silencio cuando la verdad es que nadie miraba.

Con el retraso del event loop es al revés: un segundo sin muestra no dice nada del bucle, y un cero diría que estaba libre. Así que ahí solo se publican los segundos que alguien muestreó. Y va en su propia serie, del **proceso**: atribuirlo a una ruta sería inventar una medida.

**El presupuesto de memoria se comprueba con aritmética, aquí.** El invariante 3 dice que los números son «un hecho ejecutable, no una cifra copiada en un documento», y añade que lo comprueba `make bench` en CI. **CI no ejecuta el bench** (gh-308). Las mitades de latencia y CPU dependen de que alguien lo corra a mano; la de memoria no tiene por qué: lo que este registro reserva es conocido, `bytes()` lo calcula y un test lo mantiene por debajo de dos mebibytes. Un presupuesto que se puede comprobar sin una máquina tranquila debe comprobarse sin una máquina tranquila.

## Alternativas

**Un histograma de latencia por segundo.** Daría percentiles por segundo y multiplicaría la memoria por treinta y cinco. La pregunta que responde ya la responde el intervalo.

**Un barrido por segundo que limpie todas las filas.** Más simple de leer y paga por rutas que no recibieron nada. La limpieza perezosa cuesta una comparación en la escritura que ya estaba ocurriendo.

**Emitir solo los segundos con tráfico.** Es lo que salió de la primera versión, y borra exactamente la información por la que existe este registro: el silencio.

**Reservar la ventana entera para las quinientas rutas del agregador.** Seis megabytes por proceso para una aplicación pequeña, y sin ganar nada: las rutas raras no tienen forma por segundo.

**Esperar a que existan las capturas para construir esto.** Nada de esto sale del proceso todavía, así que no entrega valor visible. Se hace igual porque es la mitad barata: si la cara —el detalle fino, gh-306— resulta más costosa de lo que el presupuesto admite, es mejor descubrirlo con la maquinaria ya construida y probada.

## Consecuencias

- La instrumentación reserva hasta **dos mebibytes** más, frente a un presupuesto de sesenta y cuatro. Es el primer trozo de ese presupuesto que se gasta, y quedan tres piezas de caja negra por venir: conviene mirarlo cada vez.
- El coste por request son cinco sumas en un array preasignado y ninguna asignación. Lo que **no** está comprobado en CI es que eso no mueva la latencia, porque el bench no corre allí (gh-308); se ha corrido a mano para este cambio.
- Nada de esto sale del proceso. No toca el protocolo, no toca el transporte y no cambia ni un byte de lo que el cloud recibe.
- Cuando existan las capturas (gh-277), `snapshot()` es lo que congelan.
