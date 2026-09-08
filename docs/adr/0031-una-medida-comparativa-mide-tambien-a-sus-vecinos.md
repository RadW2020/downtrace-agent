# ADR 0031 — Una medida comparativa mide también a sus vecinos

Estado: aceptado · Fecha: 2026-09-08 · Alcance: público

## Contexto

El benchmark alterna rondas —baseline, agente, baseline, agente— precisamente para que **cada par vea la misma
máquina**. Es el supuesto sobre el que descansa todo lo demás: los ADR 0003, 0007, 0010 y 0021 construyen encima
de él, y ninguno lo comprueba.

En una máquina compartida ese supuesto se rompe en silencio. El bench de Downtrace corre en la misma VM que el
resto de CI, con un segundo runner al lado, y los colapsos de sus rondas resultaron coincidir **uno a uno** con
los jobs del vecino: seis rondas sin nadie al lado salieron limpias —espera de pool de 36 a 79 ms, p99 de 22 a
27—, y las dos que tuvieron `docker`, `go`, `e2e` o `node` encima se hundieron —espera de 1110 y 668 ms, p99 de
43,4 y 37,0—, una por variante. En la peor de tres tiradas seguidas el pool no esperó: agotó el tiempo, con 636
errores de request y un p99 de 5003 ms.

Nadie lo vio durante semanas porque **el informe no decía nada de la máquina**. Hablaba del agente, del baseline
y del ruido, y presentaba ese ruido como una propiedad de la máquina cuando buena parte era un vecino
intermitente. El ADR 0014 lo había avisado —«medirlo junto a veintisiete contenedores de producción mediría a los
vecinos»— y el ADR 0020, al mudar el bench a esa máquina por una razón buena, cubrió que dos benchmarks no se
midieran entre sí pero no al otro runner.

## Decisión

**Cada ronda mide también lo que hizo el resto de la máquina, y el veredicto lo tiene en cuenta.**

- Se lee la CPU total del host alrededor de la ventana de medida y se le resta la que consumieron los procesos
  del propio benchmark. Lo que queda es la **CPU ajena**, en la misma unidad que `cpuPct` para poder leerlas
  juntas: 100 es un núcleo entero.
- **Donde no se pueda leer, se informa como desconocido.** Nunca como cero: no saber no es medir tranquilidad.
- **Lo que invalida un par no es que hubiera vecinos, es que hubiera vecinos distintos en cada mitad.** En esa VM
  corren los contenedores de producción, así que la CPU ajena nunca es cero; lo que rompe la comparación es el
  desequilibrio. La tolerancia es de veinte puntos de un núcleo: más que cualquier efecto propio de este
  benchmark y menos que lo que cuesta un job del vecino, que es la diferencia que la regla tiene que distinguir.
- **Se degrada a `inconclusive`, no se aborta y no se calla.** Un bench que se niega a medir porque la máquina
  está ocupada no da número, y en una máquina compartida eso sería casi siempre. Uno que mide y calla afirma lo
  que no sabe.
- **Nunca convierte un `fail` en `inconclusive`.** Un guardarraíl que un vecino ocupado puede apagar no es un
  guardarraíl. La regla solo ablanda hacia abajo desde `pass`.

## Alternativas

**Abortar la ronda y repetirla.** Es lo que haría un laboratorio. Aquí produciría tiradas que no terminan nunca
en las horas en las que hay PRs, que son todas.

**Descartar las rondas contaminadas y calcular con las demás.** Tentador y sesgado: descartar según una medida
correlacionada con el resultado sesga lo que queda, y con nueve rondas quitar dos cambia el estimador más de lo
que arregla. Se prefiere no concluir a concluir con una muestra elegida.

**Un umbral absoluto de CPU ajena.** Descartada porque en esta máquina la CPU ajena nunca es cero: el producto
corre ahí. Un umbral absoluto o no salta nunca o salta siempre, según dónde se ponga.

**Aislar el bench y no medir nada de esto.** Es lo correcto y no excluye a esto: aunque el bench acabe teniendo
la máquina para él, seguirá conviniendo que el informe lo demuestre en vez de suponerlo. El aislamiento tiene sus
propias opciones y su propia decisión (gh-200), y ninguna de ellas quita la necesidad de mirar.

## Consecuencias

- Las tiradas hechas en una máquina compartida empezarán a salir `inconclusive` más a menudo. **Eso no es una
  regresión: es dejar de afirmar lo que no se sabía.** Lo que hace falta para volver a concluir es aislamiento, y
  ahora el propio informe dice cuánto hace falta.
- El bench queda atado a Linux para esta señal. En macOS informa «desconocido» y el veredicto no se degrada.
- Los números publicados de tiradas anteriores no llevan esta columna y no se pueden reinterpretar. Quedan como
  lo que son: medidas sin saber contra qué se hicieron.
