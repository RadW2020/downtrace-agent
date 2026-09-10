# ADR 0080 — Se mide por muestreo, y se suelta lastre en orden, con suelo

Estado: aceptado · Fecha: 2026-09-10 · Alcance: público

## Contexto (gh-271)

`product.md:241` promete cuatro cosas y dos no existían: «si detecta que ella misma añade latencia, **se
autolimita**» y «si se acerca a su presupuesto de memoria, **reduce la ventana de detalle** y lo registra
como pérdida de cobertura».

Lo que había eran topes predimensionados —500 rutas, cola de 6, 1024 caracteres, desactivación al décimo
error—, que es lo que pide el invariante 3 y **ninguno reacciona a nada**. Y nada medía lo que la
instrumentación cuesta en caliente: `performance.now()` aparecía por todas partes midiendo lo que hace la
aplicación y en ningún sitio midiendo el tiempo que se va en los propios hooks.

El banco responde «¿cuánto cuesta esto?» en una máquina tranquila, con y sin. No responde «¿está costando de
más **ahora mismo, aquí**?», que es de lo que está hecho un autolímite.

## Decisión

**1. Se mide por muestreo, y en `guard`.** Todo hook pasa por ahí, así que es el único sitio que hay que
tocar y el único que los ve todos. Medir cada llamada costaría dos `performance.now()` por hook, que es
exactamente el gasto que el invariante 3 acota: **medir el coste no puede ser el coste**. Se mide uno de cada
sesenta y cuatro; los otros sesenta y tres cuestan un incremento y una comparación con máscara.

**2. La ventana y el período de muestreo son dos cosas.** Cada cuánto se cronometra un hook es una pregunta
sobre el coste de medir; sobre cuántas requests se promedia es una pregunta sobre no reaccionar a una ráfaga.
Atarlas hizo un medidor que muestreaba en cada llamada y por tanto decidía en cada request, que es un
medidor sin memoria — y lo encontró un test, no una revisión.

**3. El disparador va muy por debajo del invariante 3.** El invariante permite +1 ms en el p99; autolimitarse
al llegar ahí sería autolimitarse cuando la promesa ya está rota. Medio milisegundo por request.

**4. Se suelta lastre en orden de coste, y hay suelo.** Primero el **detalle fino**, lo más caro por
operación y que hoy nadie consume fuera de una captura; después el **perfil**, que pierde las etiquetas de
qué ejecuta una ruta y conserva todos los agregados. **Y para.**

Debajo está el agregado, que **es** el producto. Una instrumentación que lo soltara estaría viva y sin decir
nada, que es el invariante 14 puesto del revés: la ausencia de datos no puede significar que no pasa nada. Si
soltar los dos niveles no basta, se dice y no se sigue.

Y soltar tiene que parar **las escrituras**, no solo las lecturas: un registro que se sigue llenando y no se
publica cuesta exactamente lo que costaba. El registro llega a una operación por el contexto de la request,
así que lo que se deja de hacer es entregarlo.

**5. Con histéresis.** Se suelta al cruzar el presupuesto y se recupera al bajar de **la mitad**. Con una sola
línea, una ráfaga hace parpadear el nivel, y un detalle que va y viene es un detalle que nadie puede leer.

**6. Se registra, con su motivo**, en `AgentStats`: qué está soltado y por qué —la latencia o la memoria—.
Es la segunda mitad de la cuarta promesa, y es donde el gh-243 lo recogerá para mandarlo cuando pueda.

## Alternativas

**Cronometrar cada hook.** Exacto y es el coste que se quiere evitar.

**Un contador acumulado y una división al final.** Mide el reloj de pared entre hooks, que incluye el trabajo
de la aplicación: mediría la aplicación, no la instrumentación.

**Soltar observadores uno a uno por coste** —el gh-187 midió 19 ns por query del perfil y 0,117 µs del
envoltorio de `pg`—. Más fino y, sin datos reales de producción, adivinar. Dos niveles y un suelo.

**No poner suelo y apagarse del todo si hace falta.** Es lo que hace la desactivación por errores internos, y
ahí es correcto: un agente con un bug es peor que ninguno. Aquí no hay bug, hay coste, y apagarse dejaría al
cloud sin poder distinguir «no pasó nada» de «nadie miró».

## Consecuencias

- El coste de no muestrear es un incremento y una comparación, y hay un test que **cuenta las lecturas del
  reloj**: ochenta hooks, veinte lecturas con período ocho. Es la misma jugada que el ADR 0067 hizo con la
  memoria — hacer aritmética lo que dependía de que alguien acordara correr el banco.
- El banco, a mano y con control sobre `main` (ADR 0032), da `pass` en las dos ejecuciones. La diferencia
  marginal en CPU es **+0,93 pp**, dentro del ruido del propio control (±1,57) y muy por debajo del
  presupuesto de 3 — pero es la dirección que uno esperaría y **no se puede afirmar que sea cero**. La tabla
  está en el PR.
- Ningún compromiso con letra sale de la deuda. Lo que sale es que `product.md:241` deja de prometer dos
  cosas que no existían.
