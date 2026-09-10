# ADR 0100 — El punto de entrada deja el agente alcanzable, y eso no es estado global

Estado: aceptado · Fecha: 2026-09-10 · Alcance: público

## Contexto

`process.exit()` es inmediato: no espera una promesa en vuelo y **no dispara `beforeExit`**. Los dos caminos
de salida del agente dependen de que el proceso viva un momento más — en una señal, `signalled()` arranca el
vaciado y vuelve enseguida si la aplicación también escucha, para no robarle el control (invariante 2); y
`beforeExit`, que `process.exit()` se salta.

Así que `close().then(() => process.exit(0))`, que es el patrón más común que hay, corta el último vaciado:
el intervalo en curso, el perfil de la ventana (gh-371, gh-375) y la evidencia de una captura a medias
(gh-379).

No es teórico. **La app de referencia perdió esa carrera en CI dos veces seguidas**, pasando siempre en
local, y el síntoma fue un perfil que no llegaba.

## La tensión

`CLAUDE.md` dice: «las dependencias se pasan explícitas; nada de estado global». Y el agente lo cumple en
todas partes — se le pasa todo lo que usa, y no hay un singleton al que llamar.

Pero `--import @downtrace/agent/register` corre **antes de que la aplicación exista**. No hay cadena de
llamadas por la que pasar el agente: la aplicación no puede recibir lo que se creó antes que ella. O lo
alcanza por su nombre, o no lo alcanza.

## Decisión

**El punto de entrada recuerda el agente que creó, en un módulo propio, y el paquete exporta `shutdown()`.**

`src/registered.ts`: una variable, escrita una vez por `register.ts`, leída por una función. Nada más del
paquete la toca — el agente sigue recibiendo todo lo que usa como argumentos, y ese módulo no sabe nada de
lo que un agente hace.

Por qué esto no es lo que la regla prohíbe: la regla existe para que el código no **alcance** dependencias a
escondidas en vez de recibirlas, porque eso oculta el grafo y hace los tests imposibles. Aquí lo que se
alcanza no es una dependencia del agente, es **el agente mismo**, desde fuera, y el grafo no se oculta:
está en la firma exportada. El coste de no hacerlo no es estilístico — es que un usuario pierde el último
minuto de cada despliegue sin forma de saber por qué.

`shutdown()` es seguro con la instrumentación apagada —nunca se arrancó un agente—, seguro dos veces, y
**nunca lanza**: una aplicación que se va no tiene nada que hacer con un error de su telemetría. Es el único
sitio de este paquete donde tragarse un error es lo correcto, y está dicho ahí.

## Alternativas

**Que el agente se quede la señal.** Podría no devolver el control hasta haber vaciado. Es exactamente lo
que el invariante 2 prohíbe: cambiaría lo que la aplicación habría hecho, y una aplicación que apaga en
orden dejaría de hacerlo a nuestro gusto.

**Un símbolo en `globalThis`.** Mismo estado, peor sitio, y colisiona con cualquiera.

**Que el usuario llame a `createAgent` él mismo** y se guarde la referencia. Ya se puede, y es la respuesta
para quien quiera control; pedirla a todo el mundo convierte una línea de instalación en un trozo de código
que mantener.

**Documentarlo y nada más.** «No llames a `process.exit()`» es un consejo que la mitad de las aplicaciones
no puede seguir.

## Consecuencias

- El README del agente lo dice, con las dos líneas.
- Los tests son **procesos de verdad**: uno que sale sin esperar y pierde su lote, y otro que espera y lo
  conserva. El fallo se fija antes de arreglarlo, porque un proceso que no termina no puede demostrarlo
  desde dentro.
- Queda el riesgo del paquete duplicado: si la aplicación resuelve `@downtrace/agent` a una copia distinta
  de la que cargó `--import`, `shutdown()` no encuentra nada y devuelve en seguida. Falla hacia el lado
  correcto —lo mismo que hoy— y no hay forma de detectarlo desde dentro sin inventar más estado.
