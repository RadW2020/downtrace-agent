# ADR 0110 — Las muestras de referencia se eligen por embalse uniforme, y la renovación se para cuando piden detalle

Estado: aceptado · Fecha: 2026-09-11 · Alcance: público

## Contexto

`product.md:100`: «Comparar requests degradadas con requests de referencia exige conservar ambas; el
detalle fino de hace una hora ya no existe. Por eso la instrumentación conserva, por endpoint y versión,
un pequeño número acotado de requests representativas de la referencia utilizada, renovadas sin
incorporar automáticamente el comportamiento de un incidente abierto (REF-01), que viajan con cada
captura (…) Cada muestra identifica su referencia y **cómo se seleccionó**; ser anterior no acredita
salud».

La captura ya trae el detalle de lo que va mal (gh-398) y el cloud ya lo lee y atribuye (gh-403). Lo que
falta es contra qué comparar. Y el criterio de selección no es un detalle de implementación: es lo que
decide si la comparación significa algo.

## Decisión

**Embalse uniforme por endpoint (algoritmo R).** Cada request observada de ese endpoint tiene la misma
probabilidad de estar entre las guardadas, haga lo que haga. Cuesta un contador y un número aleatorio por
request, y una copia sólo cuando la muestra entra —que después de las primeras es una de cada `vistas`—.

**Y la selección viaja con las muestras**, en un enum y no en texto libre. Sin ella no sostienen ninguna
atribución (ATR-01), y un emisor que escribiera «representativas» no estaría diciendo nada.

**La ventana es la vida del proceso.** Un proceso corre una versión desplegada, así que lo «por endpoint
y versión» del producto sale solo, sin llevar la versión a ningún sitio ni inventar una ventana que
mantener.

**La renovación se para mientras el proceso está observando una captura.** Es lo más cerca de REF-01 que
la instrumentación puede estar desde dentro: no sabe si hay un incidente abierto —eso lo sabe el cloud—,
pero sabe que le han pedido detalle, que es cuando algo está pasando. Y se **declara** en la evidencia,
porque una pausa que no se cuenta es una muestra vieja sin explicación.

**El registro es el tercero de la caja negra y tiene su forma**: arrays preasignados, etiquetas interned
y un tope de memoria asertado por un test, como los otros dos (ADR 0067, 0068).

## Alternativas

**Las N más rápidas.** Sesga toda comparación posterior: cualquier degradación parece peor de lo que es,
porque la referencia no es el comportamiento normal sino su mejor cara. Es la trampa que este ADR existe
para no pisar, y hay un test con una población sesgada que lo comprueba.

**Las N últimas.** Es lo más barato y puede quedarse con un momento raro —el minuto en que el pool estaba
lleno—, y nada avisa de que eso es lo que pasó.

**Una muestra por percentil.** Conserva la forma de la distribución y necesita decidir qué percentiles,
mantenerlos al día y explicar por qué esos. Cuando haya una razón para quererlo, será otro ADR.

**Parar la renovación sólo cuando el cloud lo diga.** Exigiría un campo nuevo en el canal de control para
algo que la instrumentación ya puede deducir de lo que le piden.

## Consecuencias

- La evidencia crece: hasta 48 muestras con sus operaciones. Cuentan para el presupuesto de evidencia,
  porque son detalle que llegó.
- El registro ocupa 64 KiB como mucho, declarados y comprobados. No sale del proceso salvo en una captura,
  como el resto de la caja negra.
- El modo mínimo alcanza a las muestras: la ruta sale retenida por la misma función que el resto (ADR
  0105).
- El cloud las guarda tal como llegan y **no las re-describe**: las enseña bajo `fromService` —cada
  muestra lleva una ruta que escribió el servicio— con la frase que el producto exige, que ser anterior no
  acredita salud.
- Lo que no se hace todavía: comparar las muestras con las requests capturadas. La atribución ya sabe
  medir las dos (ADR 0109); publicar la comparación es decidir un método de poblaciones, y eso es otro
  tiquet.
