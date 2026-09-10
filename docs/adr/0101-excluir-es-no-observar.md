# ADR 0101 — Excluir es no observar, y el patrón no es una expresión regular

Estado: aceptado · Fecha: 2026-09-10 · Alcance: público

## Contexto

`product.md:104` da al operador dos controles sobre lo que sale de su servidor. Éste es el primero: «el
usuario puede excluir endpoints o dependencias completas». El otro —el modo mínimo— necesita decidir qué
enseña una ruta sin nombre, y es el gh-367.

El cloud ya sabe leerlo desde el gh-360: un lote declara **cuántos** endpoints y dependencias retiene su
emisor, y el cloud lo guarda, lo devuelve y lo pone entre las limitaciones de un resultado con palabras
distintas de las de una pérdida (ADR 0092). Faltaba quien lo mandara.

## Decisión

**Excluir es no observar.** Un endpoint excluido no entra en el agregado, ni en la caja negra, ni en el
perfil, ni en el conteo de tráfico. Una dependencia excluida no aparece en el trabajo de ninguna request, ni
sus esperas.

La alternativa —observar y no enviar— cuesta lo mismo en el camino de la request y no da nada a cambio: lo
único que el cloud necesita saber es **cuántos** faltan, y eso se cuenta igual sin guardar nada de ellos. Y
guardar en memoria del proceso lo que el operador pidió no mirar es exactamente lo que pidió que no
hiciéramos.

**Se compara con la plantilla de ruta ya normalizada**, no con el camino que llegó. Excluir `/users/123` y
no `/users/:id` sería una exclusión que no excluye nada, y el camino es lo que un operador escribiría sin
pensarlo. Hay un test que fija justamente ese caso.

**El patrón no es una expresión regular.** `*` vale por cualquier tramo, el resto es literal y tiene que
casar la cadena entera. Un patrón del usuario ejecutándose en el camino de cada request no se puede acotar
—uno con retroceso colgaría la aplicación que está vigilando— y el invariante 3 va exactamente de eso. Un
lenguaje para las dos listas, no dos.

**Se declara cuántos se han excluido de verdad**, no cuántos patrones hay configurados. La pregunta que un
lector se hace es «cuántos faltan de estos números», y un patrón que no casa con nada no falta de ninguno.
Por eso el conteo es de nombres **vistos y descartados**, y por eso un patrón que no casa no hace que el
lote declare nada.

## Alternativas

**Excluir por método además de por ruta.** «No mires `/admin`» es lo que un operador quiere decir, y
`GET /admin` sin `POST /admin` es una precisión que nadie ha pedido y que dobla la superficie de
configuración.

**Aceptar expresiones regulares.** Más potente y sin techo de coste. Si alguien lo pide con un caso real,
se decide entonces con ese caso delante.

**Contar patrones en vez de exclusiones.** Más barato y menos cierto.

## Consecuencias

- Dos variables nuevas, leídas y validadas una vez al arrancar como el resto: `DOWNTRACE_EXCLUDE_ENDPOINTS`
  y `DOWNTRACE_EXCLUDE_DEPENDENCIES`.
- Un patrón en blanco entre comas se descarta al leer. Compilado sería un patrón que casa con la cadena
  vacía, y una coma suelta en una variable de despliegue no puede convertirse en «excluye algo».
- La decisión se memoriza por nombre: hay pocas rutas y pocos objetivos, y millones de requests.
- Las exclusiones de dependencias **viajan en el contexto de la request**, porque `recordCallIn` es una
  función libre en el camino caliente y alcanzar el agente desde ahí significaría hacerlo global.
- Queda la otra mitad de la frase del producto, el modo mínimo (gh-367).
