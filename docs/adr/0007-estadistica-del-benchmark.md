# ADR 0007 — Estadística del benchmark: p99 sobre muestras agrupadas y ruido por mitades

Estado: aceptado; la estimación del ruido y la condición de `fail` en latencia están superadas por el ADR 0010, y la condición de `fail` en general por el **ADR 0030** (lo que ha de superar al ruido es el margen sobre el presupuesto, no Δ) · Fecha: 2026-09-04 · Supera la parte estadística del ADR 0003 (rondas alternas, medianas y veredicto se mantienen) · Alcance: público

## Contexto

El ADR 0003 comparaba **medianas de p99 por ronda** y estimaba el ruido como máx−mín de las rondas baseline. Con ~2400 muestras por ronda, el p99 lo deciden ~24 valores y se mueve varios milisegundos entre rondas idénticas en un runner compartido: el 2026-09-04 el bench dio `fail` (Δp99 +3,45 ms) para un agente sin cambios y `pass` al repetir. Un guardarraíl que salta sin motivo acaba ignorado; relajar el presupuesto de 1 ms no era una opción.

## Decisión

- El generador conserva **todas las muestras** de latencia de cada ronda.
- Para la latencia, el veredicto usa el **p99 del conjunto agrupado** de todas las rondas de cada variante (5 × 2400 = 12 000 muestras → el p99 lo deciden ~120 valores).
- El **ruido** de latencia se estima por **mitades**: se baraja el conjunto baseline con semilla fija, se parte en dos, |p99(A) − p99(B)|, 20 repeticiones, se toma el máximo. Es determinista y mide exactamente lo que interesa: cuánto cambia el estimador entre dos extracciones iguales.
- CPU y RSS siguen con mediana por ronda y ruido máx−mín (son estables).
- **Los errores de las rondas mandan sobre la estadística**: requests fallidas en rondas del agente → `fail` (el agente rompe la aplicación); fallidas solo en rondas baseline → `inconclusive` con motivo (no se pudo medir). Nunca `pass` con datos rotos: una ejecución en CI con dos rondas baseline degradadas (586 y 276 timeouts) había dado `pass` por −4,9 s.
- La regla `ok` / `fail` / `inconclusive`, el presupuesto y las rondas alternas **no cambian**. El informe indica `pooled n=…` en la fila de latencia; el JSON no incluye las muestras crudas.

## Alternativas descartadas

- **Más rondas con medianas**: mejora despacio (√n) y multiplica el tiempo de CI; agrupar da la misma potencia sin más rondas.
- **Histogramas en lugar de muestras**: menos memoria, pero la resolución de bucket (ADR 0004) es demasiado gruesa para un presupuesto de 1 ms; 12 000 números en memoria no son un problema.
- **Test estadístico formal (Mann-Whitney, bootstrap completo)**: más correcto en teoría, más difícil de explicar en una tabla; el criterio "Δ > presupuesto y Δ > ruido por mitades" es defendible y legible.
- **Relajar el presupuesto**: la promesa del producto es 1 ms; se mide mejor, no se rebaja.

## Consecuencias

- El agente falso de la suite deja de añadir 5 ms uniformes (una regresión de mediana que el p99 no distingue del ruido en máquinas cargadas) y pasa a retrasar 200 ms una de cada 50 requests: la regresión de cola que el presupuesto vigila, detectable con cualquier ruido observado (Δp99 ≈ +180 ms).

- Con datos sintéticos, dos distribuciones iguales dan |Δp99| < 0,3 ms y un agente de +5 ms se detecta siempre con ruido < 1 ms.
- Si el `inconclusive` reaparece con frecuencia, la respuesta sigue siendo más muestras (rps o duración), no menos presupuesto.
