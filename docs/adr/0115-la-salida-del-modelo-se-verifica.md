# ADR 0115 — La salida del modelo se verifica contra el informe; el prompt no es una garantía

Estado: aceptado · Fecha: 2026-09-11 · Alcance: público

## Contexto

`product.md:262` pone en la primera versión «redacción de la narración y propuesta de hipótesis marcadas,
con plantilla de reserva». La plantilla existe y va primero a propósito (ADR 0079). Faltaba el modelo.

Y `product.md:174` pone el límite: un modelo «puede redactar la narración a partir del informe (…) **No
puede producir métricas**, cambiar el estado de una hipótesis ni convertir una correlación en causa
confirmada». Un producto cuyo trabajo es no afirmar de más no puede cumplir esa frase pidiéndosela a un
modelo.

## Decisión

**La garantía es la verificación, no el prompt.** Cada número del texto tiene que estar declarado como
cifra, y cada cifra tiene que nombrar un campo del informe que resuelva. Un borrador que no pasa se
descarta **entero** y el consumidor lee la plantilla. Es la comprobación que `product.md:162` ya exigía y
que hasta ahora vivía en un test de la plantilla: pasa a producción, y las dos lecturas se comprueban con
el mismo código.

Las instrucciones del prompt se escriben igual —pedir bien sigue ayudando— pero no son lo que sostiene la
promesa.

**El contenido observado viaja como dato.** Las instrucciones van en el turno de sistema; el informe, en
el del usuario, como un documento. Un mensaje de error que diga «ignora las instrucciones anteriores» es
texto dentro de un JSON dentro del turno de datos (invariante 12). Y si aun así el modelo obedeciera, su
respuesta no pasaría la verificación: las dos defensas son independientes a propósito.

**Cualquier duda es la plantilla.** Error, tiempo agotado, JSON ilegible, texto vacío, una cifra que no
resuelve. Nunca media narración del modelo. La plantilla se escribe **antes** de llamar, así que el coste
de rendirse es un párrafo más plano y nunca una respuesta que falta.

**Una llamada por versión de informe, no por lectura.** El informe se calcula al leer (ADR 0065) y una
llamada de pago por cada recarga sería una trampa de coste para quien lo encienda. Se recuerda en memoria,
acotado, con la huella del informe **sin su narración** como clave.

**La narración sale de la versión del informe.** RES-01 le da a la versión un solo trabajo: identificar el
estado del que dependería una operación. La prosa no es ese estado —sus cifras son campos, y los campos sí
están dentro— y ahora puede venir de un modelo que este segundo contesta y el siguiente no. Con la
narración dentro, un modelo que fallara una vez cambiaría la versión de un informe cuyos hechos no se han
movido, y una operación que llevara la anterior se rechazaría sin motivo.

**Sin clave no hay cliente.** `narrate.New` devuelve nil, y nil significa que no hay modelo. Es el estado
por defecto de este cloud y lo que hace cierto `product.md:63`: «los resultados no dependen de un modelo
de lenguaje».

## Alternativas

**Confiar en el prompt.** Es lo que hace casi todo el mundo y es exactamente lo que este producto no puede
permitirse: una cifra inventada en la narración es indistinguible de una medida para quien la lee.

**Dejar que el modelo escriba y marcar el texto como «generado por IA».** Traslada el problema al lector,
que no tiene el informe delante para comprobar nada.

**Pedirle solo prosa, sin cifras.** Habría evitado la verificación y habría hecho la narración inútil: lo
que un lector necesita es «pasó de 120 a 480 ms», no «empeoró bastante».

**Guardar la narración en la base de datos.** Una tabla, una migración y una retención para algo que se
recalcula. La memoria acotada del proceso basta para lo que esto resuelve, que es no pagar dos veces por
la misma lectura.

**Elegir proveedor por el usuario.** La URL base y el modelo son configuración. El cliente habla la API de
mensajes de Anthropic porque su separación entre turno de sistema y turno de datos es exactamente la que
el invariante 12 necesita, no por preferencia.

## Consecuencias

- La primera dependencia externa del cloud, y está **apagada por defecto**. Sin clave no sale ninguna
  petición y el comportamiento es el de antes de este ADR.
- Un modelo caído o lento cuesta un párrafo más plano. Nunca un informe que no carga.
- La verificación también se aplica a la plantilla, así que el día que la plantilla se equivoque, fallará
  igual.
- Falta la otra mitad de la fila de producto: las **hipótesis propuestas por el modelo**, que nacen *no
  evaluada* y marcadas (HIP-01). Tiene su propio tiquet: el modelo escribiendo hipótesis toca el estado de
  algo, y esto solo toca la prosa.
