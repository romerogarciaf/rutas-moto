# Rutas de Curvas

Aplicación web personal para diseñar rutas en moto por carreteras de curvas en Madrid y alrededores. Está pensada para usarse en el iPhone como app instalada desde Safari.

## Qué hace (versión 1)

- Muestra en el mapa los tramos de curvas en tres colores: amarillo (curvas), naranja (muchas curvas) y rojo (muy revirado). Cada tramo indica sus km y un tiempo aproximado.
- **Tramos**: tocas tramos en el mapa y se van añadiendo a la ruta en orden. Al final puedes volver a la salida, ir a otro destino o terminar ahí.
- **A → B**: diseña una ruta con curvas entre dos puntos, con el máximo de curvas, un % de tiempo extra sobre la ruta rápida o un tiempo total máximo.
- **Circular**: vuelve al punto de salida y se limita por tiempo total o por km, con una dirección opcional.
- Reparte el tiempo en ida, zona de curvas y vuelta.
- Evita peajes si lo eliges.
- Marca las gasolineras de la ruta y avisa si algún tramo supera tu autonomía menos el margen de seguridad.
- Guarda rutas favoritas en el iPhone.
- Exporta a GPX (para Calimoto) y abre la ruta en Google Maps, partida en etapas si hace falta.
- Muestra tu posición en el mapa y puede seguirte con la pantalla encendida.

## Datos y servicios

- Carreteras: OpenStreetMap, consultado a través de la API pública Overpass. Las curvas se calculan en el propio móvil y se guardan para no volver a descargarlas.
- Cálculo de rutas y búsqueda de lugares: OpenRouteService (HeiGIT), con tu clave personal. La clave se guarda solo en el iPhone, en Ajustes.
- Gasolineras: OpenStreetMap.

## Instalar en el iPhone

1. Abre en Safari la dirección de GitHub Pages del repositorio.
2. Pulsa Compartir y luego **Añadir a pantalla de inicio**.
3. Abre la app, entra en Ajustes y pega tu clave de OpenRouteService.

## Pendiente para la versión 2

- Radares fijos (datos oficiales de la DGT).
- Aviso al salirte de la ruta.
