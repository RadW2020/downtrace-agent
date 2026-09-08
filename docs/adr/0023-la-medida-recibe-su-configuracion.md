# ADR 0023 — El benchmark recibe su configuración; no la busca en el disco

Estado: aceptado · Fecha: 2026-09-08 · Supera del ADR 0003 la lectura de `packages/reference-app/.env` por el harness · Alcance: público

## Contexto

El harness del benchmark arrancaba la app de referencia con `--env-file-if-exists=packages/reference-app/.env`. Ese
fichero está en `.gitignore`: existe en la máquina del operador y no en CI, donde el flag lo salta **en silencio**.
No era un olvido, estaba decidido: el ADR 0003 lo dice en sus consecuencias, y tenía su razón —en esa máquina los
puertos 5432 y 6379 están ocupados por otro proyecto, y sin el fichero `make bench` no encuentra la base de datos—.

Lo que lo convierte en un problema es para qué sirve el benchmark. Su valor entero es que **dos números se puedan
restar**: el mismo tráfico, la misma máquina, la misma aplicación, con y sin agente. Dentro de una ejecución eso
estaba garantizado. Entre máquinas no: un número medido en el portátil y otro medido en CI arrancaban la aplicación
de formas distintas, y nada lo advertía.

Y muerde justo ahora. El ADR 0020 dejó escrito que el coste del agente en CPU es 2,44–2,72 pp en la máquina de CI
frente a 1,346 pp en x86, y el reparto por instrumento se mide en local (gh-139). Si el arranque no es el mismo, esas
comparaciones arrastran una diferencia que no aparece en el informe.

Además el agravante que hace el fallo silencioso en vez de ruidoso: `configFromEnv` de la app de referencia tiene
**valores por defecto**, así que sin fichero y sin variable la aplicación no protesta, se conecta a
`localhost:5432` y la medida sale de servicios que nadie eligió.

## Decisión

**El harness exige `DATABASE_URL` y `REDIS_URL` por nombre y no lee ningún fichero de entorno.** Si falta una,
termina diciendo cuál y por qué importa.

**Nada las inyecta por detrás.** Ni el harness, ni el `Makefile`: quien mide, exporta. `make dev` ya las conoce, y
el `README` del paquete dice cómo hacerlo en una línea. La comodidad de no escribirlas no vale una medida que no se
puede comparar con otra.

Es la misma regla que el gh-128 aplicó al test e2e por el mismo motivo, y la que `CLAUDE.md` ya pedía para el
código: la configuración se lee y valida una vez, explícita, y no se busca.

## Alternativas descartadas

- **Seguir leyendo el fichero y anotar en el informe qué variables trajo.** Conserva la comodidad y hace la
  comparabilidad comprobable, que es su mérito. Pero añade maquinaria al informe para describir un problema que se
  puede quitar, y deja al lector la tarea de decidir si dos informes son comparables.
- **Que el `Makefile` cargue el fichero**, como hace `scripts/demo.sh` con su comentario. Es honesto para una demo
  en la máquina de alguien y sigue siendo invisible para quien compara dos números: el arranque continuaría
  dependiendo de un fichero que no está en el repositorio.
- **Dejarlo y escribir que local y CI no se comparan.** Es la opción que no arregla nada y convierte una limitación
  evitable en doctrina.
- **Que la app de referencia deje de tener valores por defecto** y falle sin configuración. Arreglaría el fallo
  silencioso en su origen, y rompería `make dev` y el arranque de alguien que solo quiere verla funcionar. La app es
  un juguete a propósito; el benchmark es el que necesita rigor.

## Consecuencias

- `make bench` en una máquina nueva falla en la primera línea con lo que le falta, en vez de medir contra una base
  de datos que nadie eligió.
- Un número medido en local y otro medido en CI arrancan la aplicación igual. Siguen sin ser comparables por otras
  razones —arquitectura, ruido, vecinos—, pero ya no por esta.
- El ADR 0003 mantiene todo lo demás; lo superado es esa consecuencia suya.
