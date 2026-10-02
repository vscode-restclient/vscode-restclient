# Los 61 pull requests abiertos del proyecto original

Triaje del 24 de agosto de 2026, con `scripts/triage-prs.mjs`. El detalle
completo está en `docs/triage-prs.json`.

**Nueve de los sesenta y uno aplican limpio** sobre esta base; los otros 52
tienen conflictos por cuatro años de deriva. De esos nueve, la mayoría son
actualizaciones de dependencias que aquí ya se hicieron a mano.

La regla es la misma para todos: **nada entra sin una prueba que lo cubra**.
Y eso no es burocracia. De los cinco revisados a fondo, **dos había que
rechazarlos**, y uno de ellos habría roto a todo el mundo.

## Aceptados

| PR | Qué arregla | Prueba |
|---|---|---|
| **#1440** | La respuesta no se mostraba en **Cursor**: el código daba por hecho que `window.activeTextEditor.viewColumn` existe, y ahí puede ser `undefined`. Enviabas la petición y no pasaba nada | P-26 |
| **#1432** | Reenviar una petición arrastraba las cabeceras que la primera llamada había manipulado (issue #682, de 2021). Ahora se trabaja sobre una copia | P-28 |
| **#853** | Un JSONPath que casa con varios valores devolvía solo el primero, en silencio. Ahora los devuelve todos | P-29 |

## Rechazados

### #1396 — «Fix IPv6 Support for Localhost»

Añade un agente DNS propio para que `localhost` resuelva a IPv6. Suena
razonable y hace lo contrario: **con el parche aplicado, una petición a
`localhost` contra un servidor que solo escucha en `::1` no llega; sin él,
llega**. Node resuelve `localhost` correctamente desde hace años.

Se comprobó de las dos formas: la prueba P-27 pasa sin el parche y falla con
él. La prueba se queda en la suite, protegiendo el comportamiento bueno.

### #532 — «Eval system variable» (4 votos, el más votado de los que aplican)

Añade `{{$eval comando}}`, que ejecuta el comando con `child_process.exec`
tomándolo del propio fichero `.http`.

Eso convierte cualquier `.http` en ejecución de código arbitrario: basta con
clonar un repositorio ajeno, abrir su fichero de peticiones y pulsar «Send
Request». La extensión declara `untrustedWorkspaces: limited` precisamente
porque un `.http` puede venir de cualquier parte.

No se rechaza la idea, se rechaza la forma. Para entrar necesitaría, como
mínimo: un ajuste propio desactivado por defecto, negarse a funcionar en
espacios de trabajo no confiables, y una confirmación explícita la primera
vez que un fichero pide ejecutar algo.

## Pendientes de revisar

| PR | Por qué no se ha tocado |
|---|---|
| #1359 | Rutas XDG en Linux. Bajo riesgo, hace falta probarlo en Linux de verdad |
| #1427 | Convertir JSON a formulario. Toca el parser: necesita pruebas propias |
| #1336 | Audiencia `api://` para Azure AD. **No se puede probar sin credenciales de Azure**, la misma razón por la que `adal-node` sigue donde está |
| #664 | CodeLens con el entorno actual. Función nueva, no arreglo |

## Los 52 con conflictos

Casi todos son de dependencias (`Bump …`) que aquí ya se resolvieron por otra
vía, o parches de 2019-2022 sobre código que ha cambiado. Se revisarán por
valor, no por antigüedad: primero los que arreglan algo que le pasa a alguien
hoy.
