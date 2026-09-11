# ADR 0117 — Una hipótesis propuesta por el modelo no lleva números y no recomienda nada

Estado: aceptado · Fecha: 2026-09-11 · Alcance: público

## Contexto

El ADR 0115 dejó al modelo redactando la narración, con su salida verificada cifra a cifra contra el
informe. `product.md:174` le permite una segunda cosa: «proponer hipótesis que las reglas no
contemplaban, **marcadas como propuestas por el modelo y en estado *no evaluada*** hasta que las reglas
las contrasten con la evidencia», y le prohíbe tres: producir métricas, cambiar el estado de una
hipótesis y convertir una correlación en causa confirmada.

La verificación de la narración no sirve aquí. Una cifra del texto se ata a un campo del informe porque
el texto habla de números que el informe tiene; una hipótesis es prosa, y no hay campo al que atar nada.

## Decisión

**Una propuesta no puede contener ningún dígito.** Más simple y más dura que la verificación de la
narración, y por la misma razón: un número dentro de una hipótesis es una medida que el modelo tomó.
Una hipótesis es cualitativa —«los reintentos del proveedor podrían estar amplificando la carga»— y
perder la que traiga un «40 %» cuesta una frase, no una capacidad.

**Nace *no evaluada*, y su `wouldNeed` dice que nada la va a mover.** Las reglas solo evalúan las
hipótesis que ellas derivan, así que prometer que alguien la contrastará sería exactamente el silencio
con buena cara que el invariante 14 prohíbe. Lo dice: «nothing will move this one».

**No genera recomendación.** Toda hipótesis *no evaluada* produce hoy una de tipo «averiguar». Una
propuesta haciéndolo sería el modelo empujando una acción dentro de un informe que `product.md:63`
promete que no depende de él. Se excluye por procedencia, y la exclusión está escrita donde se lee.

**Se añaden al final y no tocan nada.** Las derivadas conservan su orden, su identificador y su estado;
una propuesta que intente usar un identificador ya tomado se descarta. Y se calculan **después** de las
recomendaciones, así que no pueden convertirse en una ni por accidente: la exclusión por procedencia es
el segundo cinturón, no el único.

**Una propuesta mala cuesta solo ella misma.** Se juzgan de una en una, y ninguna arrastra a la
narración ni a sus hermanas — igual que una narración refutada no se lleva por delante las propuestas.

## Alternativas

**Verificarlas como la narración, cifra a cifra.** No hay a qué atarlas: el campo que sostiene un número
en el texto es un campo del informe, y una hipótesis nueva habla precisamente de lo que el informe no
tiene.

**Dejarlas traer evidencia.** Sería el modelo decidiendo qué sostiene qué, que es evaluar.

**Publicarlas fuera de las hipótesis, en una lista aparte.** Separa lo que HIP-01 quiere junto: un lector
tiene que ver todas las explicaciones candidatas con su estado y su procedencia en el mismo sitio, o
comparará una lista con otra y la procedencia dejará de ser lo primero que ve.

**Un estado nuevo, «propuesta».** Confunde procedencia con evaluación. *No evaluada* ya existe y
significa exactamente lo que le pasa a ésta.

## Consecuencias

- La fila de producto del modelo de lenguaje queda completa: narración y propuestas marcadas.
- Nada lee las propuestas todavía, y su `wouldNeed` lo dice. Lo que las haría útiles es una regla que
  sepa contrastarlas, que es un detector nuevo y es producto.
- Con el modelo apagado —el estado por defecto— el informe es exactamente el de antes.
- El cap de tres es arbitrario y está escrito como tal: un informe con veinte conjeturas es un informe
  que nadie lee, y las reglas que las ordenarían no existen.
