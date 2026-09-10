# ADR 0068 — El detalle fino son dos anillos con cursores absolutos, y guarda inicio y fin

Estado: aceptado · Fecha: 2026-09-09 · Alcance: público

## Contexto

Segunda pieza de la caja negra y la cara. `product.md:93` pide «cada request con sus operaciones hijas, **tiempos y orden**», y esa última palabra es toda la razón de que exista: los agregados ya dicen que una ruta ejecutó cincuenta y seis consultas, y solo una secuencia con principios y finales dice si fueron una detrás de otra o todas a la vez. Esa diferencia es la que separa el tiempo **añadido** a la request del tiempo que la request pasó esperando algo que ya había pedido.

Tres afirmaciones que el cloud hoy se niega a hacer estaban esperando a este registro: la atribución al camino crítico (ATR-01, ADR 0055), el conteo de requests dañadas (IMP-01, ADR 0060) y el total único entre hallazgos (ESC-03).

## Decisión

**Dos anillos preasignados con cursores absolutos, no un array por request.** Un array de objetos por request paga una asignación por request y otra por operación, que es exactamente lo que el invariante 3 acota. Dos `Float64Array` no pagan ninguna. Los cursores son **monótonos**: una operación sigue viva exactamente mientras `cursor - el suyo < capacidad`, así que los dos anillos pueden dar la vuelta por separado sin que una request llegue a leer las operaciones de otra.

**Se guarda inicio y fin, no duración.** Es un número más por operación, y es el número que da valor a todo lo demás: con inicio y fin se calculan orden, solapamiento y camino crítico; con la duración sola, ninguno de los tres. Los tiempos son **relativos al comienzo de su request**, para que no crezcan con el tiempo que lleve el proceso arriba y para que dos requests se comparen sin restar nada.

**El registro llega por el contexto de la request, no por una variable de módulo.** La operación se escribe donde ocurre —dentro del instrumento de `pg`— y buscar allí un singleton sería estado global, que este repositorio no tiene. El contexto lo lleva, y el agente se lo pasa al abrirlo.

**El tope por request limita las escrituras, no solo las lecturas.** Es la decisión que parece un detalle y no lo es: si el tope se aplicara al leer, una request con veinte mil consultas escribiría veinte mil entradas y **se llevaría por delante el detalle de todos sus vecinos**. Limitando la escritura, una request desbocada solo se cuesta a sí misma. Y se sigue **contando** más allá del tope, porque la diferencia entre lo contado y lo escrito es lo que permite decir «truncada» en vez de dejarla pasar por pequeña.

**El detalle perdido se dice.** Cuando el anillo de operaciones ha dado la vuelta sobre las de una request, se devuelve sin ellas y **marcándolo**, nunca como una lista vacía: vacía se lee como «no ejecutó nada», y lo que ocurrió es que nadie las conserva ya. El tiempo de esa request sigue siendo cierto; lo que se perdió es el detalle (invariante 14).

## Alternativas

**Un array de operaciones por request.** Lo natural en JavaScript y lo caro: una asignación por request y otra por operación, en el camino de cada consulta.

**Un solo anillo de operaciones con el identificador de la request en cada fila.** Ahorra el anillo de requests y obliga a recorrerlo entero para reconstruir una, y a guardar el identificador en cada operación. Dos anillos con un tramo son menos memoria y una lectura directa.

**Guardar duración en vez de inicio y fin.** La mitad de espacio y la mitad de la razón por la que esto existe.

**Aplicar el tope solo al leer.** Es lo que escribí primero, y una prueba de mutación lo destapó: quitando el límite de escritura no fallaba ningún test, porque todos miraban lo que se lee. La propiedad que faltaba era la de los vecinos.

**Guardar también el texto normalizado.** Ya viaja en el perfil por intervalos, y aquí no añade nada que el hash no dé. Lo que sí añadiría es una copia más de contenido del usuario en memoria (invariante 5).

## Consecuencias

- El agente reserva **un mebibyte más**, y la suma de la caja negra va por tres de los sesenta y cuatro del presupuesto. Queda una pieza (gh-307).
- El coste por operación son tres escrituras en un array preasignado y un incremento; por request, siete. Ninguna asignación. Lo que **no** puede afirmarse es que eso no mueva la latencia en una máquina real: desde el ADR 0032 el bench no corre en CI, y se ha corrido a mano con una ejecución de control, cuyos números están en el PR.
- Solo entran las consultas de Postgres, que son las únicas con huella. Redis y el HTTP saliente pasan por los contadores de dependencia y entrarán cuando tengan una.
- `recordOperationIn` pasa a recibir un objeto. Tenía cinco argumentos posicionales, dos de ellos números que significaban cosas distintas, y este cambio le añadía un sexto.
- Nada sale todavía del proceso. Lo congelará una captura (gh-277), y hasta entonces esto es coste sin beneficio visible: se acepta porque las tres afirmaciones que desbloquea son las que más limitan hoy lo que el producto puede decir.
