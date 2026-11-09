# Ideas para la versión GPS

Notas para cuando la app incorpore navegación propia.

## Paradas intermedias que se pasan solas

**Problema en Google Maps:** al llegar a una parada intermedia, obliga a pulsar un botón en la pantalla para seguir hacia la siguiente. En moto eso supone parar y quitarse los guantes.

**Cómo debe funcionar en nuestra app:**
- Al llegar a una parada intermedia, mostrar el botón «Ir a la siguiente parada», como Google Maps.
- Si pasan unos **15 segundos** y el GPS detecta que ya te diriges hacia la siguiente parada, el botón desaparece y la app da la parada por pasada y continúa sola.
- El botón sigue disponible durante esos segundos por si se quiere pasar antes.

Notas técnicas para implementarlo:
- «Te diriges hacia la siguiente»: la distancia a la parada actual crece y la distancia por ruta a la siguiente decrece de forma sostenida, o la posición avanza sobre el tramo de ruta que sale de la parada.
- Con las paradas «sin entrar en el pueblo», el punto de paso es el que está ~1,5 km antes del pueblo, así que la detección debe usar ese punto.
