# ADR 0033 — El modo de inspección no necesita cuenta, y enseña el cuerpo exacto

Estado: aceptado · Fecha: 2026-09-08 · Alcance: público

## Contexto

`product.md` cuenta el modo de inspección local entre las cosas que Downtrace **sí** garantiza, y lo dice dos
veces: «un modo de inspección local que muestra lo que se enviaría sin enviarlo» y «un modo de inspección local
con el que comprobar exactamente qué se enviaría». No existía.

Lo único parecido era `DOWNTRACE_DEBUG`, que escribe la *actividad* de la instrumentación —«sent 3 interval(s)»,
«cloud responded 429»— y nunca su contenido. Para ver un lote había que levantar un servidor propio y apuntarle
`DOWNTRACE_URL`, que no es algo que se le pueda pedir a quien está decidiendo si mete esto en su producción.

Y con el gh-186 dejó de ser una carencia teórica: el perfil de huellas lleva **texto normalizado de consultas**,
que es el primer campo del protocolo donde un literal puede colarse. El ADR 0028 dice que ahí es donde hay que
mirar con lupa. Esto es la lupa.

## Decisión

**`DOWNTRACE_INSPECT` escribe cada lote exactamente como se enviaría, y hace opcionales el token y la URL.**

- **El cuerpo serializado, byte a byte.** Una línea de JSON por lote. No un resumen ni una vista renderizada: lo
  que se inspecciona tiene que ser lo mismo que viajaría, o la inspección no prueba nada. Y una línea por lote es
  lo que se pasa por `jq` y lo que se puede *grepear* buscando la cadena que uno teme que se escape.
- **Sin cuenta.** Con el destino puesto y sin token ni URL, la instrumentación observa, agrega y escribe, y **no
  envía nada**. Ese es el recorrido que importa: instalar, poner una variable, arrancar la aplicación y leer el
  fichero, **antes** de confiarle nada a nadie. Una garantía que exige darse de alta para comprobarla no sirve
  para lo que existe.
- **También conectado.** Con token y URL, escribe **y** envía, y lo escrito es el mismo cuerpo que salió. Un
  despliegue en marcha se audita sin apagarlo, y lo que se lee es lo que de verdad viajó.
- **Media nube sigue siendo un error.** Una URL sin token, o al revés, se sigue rechazando al arrancar aunque
  haya destino: es una configuración equivocada y merece decirse, no taparse.
- **Escribir nunca rompe la aplicación.** Un destino ilegible se registra **una vez** y la instrumentación sigue.
  El invariante 2 no admite excepciones por una herramienta de diagnóstico, y un aviso por intervalo sería su
  propio problema.

## Alternativas

**Un subcomando o una herramienta aparte** que leyera un fichero y lo explicara. Descartada: la pregunta no es
«¿qué forma tiene un lote?» sino «¿qué produce **mi** aplicación con **mis** rutas?», y eso solo se responde con
la instrumentación puesta y tráfico real pasando.

**Enseñar una vista legible en vez del JSON crudo.** Más agradable de leer y peor para lo que sirve: en cuanto la
vista y el cuerpo son dos artefactos distintos, inspeccionar deja de demostrar nada sobre lo que sale. Quien
quiera legibilidad tiene `jq`.

**Que el modo de inspección implique no enviar, siempre.** Habría hecho imposible auditar un despliegue vivo, que
es justo donde aparece el caso raro. Lo que decide si se envía es si hay nube configurada, no si se está mirando.

**Reutilizar `DOWNTRACE_DEBUG`.** Mezcla dos cosas con públicos distintos: la actividad interesa a quien depura la
instrumentación, el contenido a quien decide si confía en ella. Y activar el segundo sin querer, al buscar el
primero, escribiría el texto de sus consultas en un log que quizá se recoge en otro sitio.

## Consecuencias

- Un usuario puede comprobar el **invariante 5 sobre su propia aplicación** sin darnos nada. Hasta ahora la
  respuesta a «¿qué sale de mi servidor?» era «lee nuestro código».
- El fichero crece y **nadie lo rota**: es del usuario, y el README lo dice. Rotarlo por él sería decidir por él
  cuánto le importa.
- Lo escrito puede contener el texto normalizado de sus consultas. Es el objetivo, y es información que ya estaba
  en su máquina; pero el README avisa de que ese fichero merece el mismo cuidado que un log de aplicación.
- Queda una asimetría que conviene nombrar: el modo enseña lo que **esta versión** de la instrumentación produce.
  Si una futura añade un campo, lo enseñará también, pero nadie avisa de que apareció. Comparar dos versiones es
  otro trabajo.
