# Breitan · Web App Privada

Aplicación local con diseño glass para dos servidores, imágenes, notas, contraseñas, redes WiFi, calculadora, QR e IA. No incluye correo ni baúl.

## Mejoras incluidas

- Alertas locales de caída de servidor y límites de CPU, RAM y disco. Puedes activar notificaciones del sistema desde **Servidores**.
- Historial de métricas de 24 horas, 7 días y 30 días. La app toma muestras mientras el proceso local está abierto y hay una sesión desbloqueada.
- Vista y control de contenedores Docker de CasaOS por SSH. El usuario SSH debe poder ejecutar `docker`.
- Historial de despliegues, logs recientes y botón de nuevo despliegue para Render.
- La IA propone cambios para revisión antes de aplicarlos. Los cambios en datos locales se pueden deshacer durante 30 minutos en la misma sesión; acciones externas como reiniciar un contenedor o desplegar no son reversibles desde la app.
- Backups automáticos cifrados con intervalo y cantidad de versiones configurables. Funcionan mientras el proceso local está abierto y hay una sesión desbloqueada.
- Análisis local de contraseñas débiles, repetidas y antiguas.
- Conversión de imágenes por lotes, importación de carpeta y descarga ZIP. El conversor elimina metadatos de origen.
- Descarga de QR para cada red WiFi guardada.
- Etiquetas para registros y una vista **Etiquetas** para filtrarlos entre módulos.

## Iniciar

Necesitas Node.js 20 o superior. En esta carpeta:

```powershell
npm install
npm run build
npm start
```

Abre **http://127.0.0.1:8787**. En la primera visita crea el usuario y la contraseña de la app. Para desarrollo con recarga automática usa `npm run dev` y abre **http://127.0.0.1:5173**.

## Conectar los dos servidores

En **Servidores → Añadir servidor**:

1. Para Render, elige **Render API** y escribe el ID `srv-...` de tu servicio y tu API key de Render. Las métricas del plan gratuito pueden ser parciales o tardar en aparecer. La app muestra `N/D` cuando Render no ofrece un valor.
2. Para CasaOS en Debian, elige **Debian / CasaOS por SSH** y escribe IP o dominio, puerto, usuario y contraseña SSH o clave privada. Este equipo debe poder alcanzar el servidor por SSH. La app lee CPU, RAM, disco y tiempo activo desde Debian.

También existe la opción **Endpoint HTTP de métricas**. Debe devolver JSON con `cpu`, `ram` y `disk` como porcentajes; `host`, `os`, `uptime`, `storageUsedGB` y `storageTotalGB` son opcionales.

## Configurar la IA

En **Configuración → Conexión de IA**, escribe un endpoint compatible con OpenAI Chat Completions, nombre de modelo y API key. Ejemplo de forma del endpoint: `https://tu-proveedor/v1/chat/completions`.

El agente puede consultar y modificar registros, leer métricas de servidores, convertir imágenes de la biblioteca y crear QR. La app enviará al endpoint configurado la conversación y los datos necesarios para cada acción. La API key se usa desde el proceso local del servidor; no se incrusta en el código del navegador.

## Datos y seguridad

- El servidor escucha únicamente en `127.0.0.1`.
- Los datos se cifran en `local-data/vault.json` con AES-256-GCM y una clave derivada de la contraseña de acceso. Esta carpeta está excluida de Git.
- **Configuración → Backup local** exporta e importa un archivo cifrado. Para restaurarlo necesitas la contraseña que tenía la app al exportarlo.
- Las imágenes se guardan dentro del almacén cifrado; cada archivo puede tener hasta 20 MB. El conversor acepta los formatos compatibles con Sharp y exporta PNG, JPEG, WebP, AVIF, TIFF o GIF.
- Si pierdes la contraseña y no tienes backup utilizable, no hay recuperación de datos.

## Verificación

```powershell
node scripts/smoke.mjs
npm audit --audit-level=high
```

La prueba usa una carpeta temporal. No configura las credenciales de tu instalación real.
