# ADR 0019 — La versión de `@downtrace/protocol` y la del protocolo son un solo número

Estado: aceptado · Fecha: 2026-09-07 · Alcance: público

## Contexto

`@downtrace/protocol@0.4.0` hablaba protocolo `0.5.0`. Dos números para la misma cosa, en un paquete cuyo único
trabajo es llevar el contrato.

No es arbitrario, y por eso costaba verlo: los dos números los decide alguien distinto en un momento distinto. El
`enum` del campo `protocol` en el esquema decide la versión del protocolo, y se edita cuando se añade un campo.
La versión del paquete la decide Changesets, y se calcula al abrir el PR de versiones. Momentos distintos,
decisores distintos, números distintos.

**Cómo se separaron, medido.** Estuvieron alineados hasta 0.2.1, que además es el patrón sano: un cambio que solo
tocaba el paquete se llevó el segmento de parche y el protocolo no se movió. La separación ocurrió el 2026-09-06,
cuando el protocolo subió a 0.3.0 y a 0.4.0 en dos PRs dentro de la misma ventana de publicación. Changesets
**agrega**: dos changesets `minor` producen **un** incremento menor. El protocolo subió dos escalones y el paquete
uno.

El coste no es la confusión de hoy, que se explica en un párrafo. Es que hiciera falta el párrafo. Un README
público que tiene que explicar por qué dos números que parecen el mismo no lo son es un impuesto permanente, y
nadie lo recuerda cuando importa. Además contradice el espíritu del invariante 9: el protocolo se define una sola
vez, y su versión estaba definida dos.

## Decisión

**Un solo número.** El `major.minor` de la versión del paquete es el `major.minor` de la versión del protocolo que
habla. `@downtrace/protocol@0.5.0` habla protocolo `0.5.0`.

- **El segmento de parche queda libre** para cambios que solo tocan el paquete: un README, un arreglo interno, un
  export nuevo. Mientras el proyecto sea pre-1.0 eso es semver correcto, porque en `0.x` el segmento que rompe es
  el menor y una adición es un parche.
- **Lo comprueba `scripts/check-protocol-version.sh`**, en `make ci` y en el job `node`. Compara el
  `major.minor` que publicarían los changesets pendientes, no el que hay en `package.json`, contra el último valor
  del `enum` del esquema. Por eso funciona también en el PR que sube el protocolo, donde el paquete todavía no se
  ha movido, y en el propio PR de versiones, que es donde aparece el número que verá el mundo.
- **Como máximo un incremento menor del protocolo entre publicaciones.** No es una restricción nueva: el ADR 0008
  ya dice que el cloud va primero y que el agente va después, «nunca en el mismo PR ni en la misma publicación».
  Lo que ocurrió el 2026-09-06 fue saltarse esa cadencia, y la separación de versiones es su huella.

Alinearlos hoy sale gratis: 0.4.0 más el `minor` pendiente da 0.5.0, que es justo la versión del protocolo.

## Alternativas descartadas

- **Documentar que son distintos**, que es lo que hacía la primera versión de este trabajo. Es lo más barato de
  escribir y lo más caro de mantener: el párrafo se queda para siempre en un README público y no impide ni un solo
  error, solo lo explica después.
- **Sacar la versión de las manos de Changesets y generarla desde el esquema.** Es lo más directo y es pelearse
  con la herramienta: Changesets es dueña del campo `version` y del changelog, y tratar un paquete como excepción
  vuelve ilegible el PR de versiones, que es lo único que se revisa antes de publicar.
- **Comprobarlo solo al publicar**, en el `release.yml` del espejo. Es el momento exacto en que equivocarse duele,
  y llega tarde: bloquea una publicación en vez de un PR, con el arreglo a dos repositorios de distancia.
- **Que la versión del paquete mande sobre la del protocolo.** Es circular. La versión del protocolo hay que
  elegirla al editar el esquema, y la del paquete no se sabe hasta la publicación.

## Consecuencias

- Subir el protocolo dos veces entre publicaciones ahora rompe CI, con el mensaje diciendo cuál de las dos causas
  es. El arreglo es publicar la versión pendiente antes de volver a tocar el esquema, que es lo que el ADR 0008
  quería de todas formas.
- **Esto caduca en 1.0.** Cuando el menor deje de ser el segmento que rompe, un export nuevo merecerá un menor y
  chocará con la regla. Hará falta un ADR nuevo que decida si el paquete se separa entonces del protocolo o si el
  contrato pasa a tener su propio nombre de versión.
- La versión del agente sigue siendo independiente: `@downtrace/agent` es software, no un contrato, y puede
  publicar arreglos sin decir nada del protocolo.
- El hueco entre el PR que sube el protocolo y el PR de versiones es legítimo y la comprobación lo contempla, por
  comparar contra lo que los changesets publicarían en vez de contra lo que hay escrito.
