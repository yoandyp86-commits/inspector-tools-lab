# Inspector Tools Lab

Fork personalizado de **Salesforce Inspector Reloaded** con funcionalidades propias
para administración de Salesforce (helpdesk / integraciones).

- Basado en: [Salesforce Inspector Reloaded](https://github.com/tprouvot/Salesforce-Inspector-reloaded) de Thomas Prouvot.
- Licencia: **MIT** (ver [`LICENSE`](LICENSE)). Se conserva el copyright original.
- Manifest **V3**. React **v15.4.0**.
- Autenticación por cookie de sesión de Salesforce (sin OAuth en uso normal).

## Estructura

El código de la extensión vive en la carpeta [`addon/`](addon/) (el `manifest.json`
está en la raíz de esa carpeta). Para cargarla en modo desarrollador:

1. `chrome://extensions` → activar **Modo desarrollador**.
2. **Cargar descomprimida** → seleccionar la carpeta `addon`.
3. Tras cambios: pulsar ↻. Si se tocó el manifest, Quitar + Cargar de nuevo.

## Funcionalidades propias añadidas

- **PS** (pestaña Users): permission sets y grupos asignados a un usuario.
- **Deleg** (pestaña Users): delegaciones del usuario (objeto `DelegationUser__c`).
- **Tools**: hub de herramientas propias.
- **Field Permissions by PS**: campos y nivel de acceso por permission set.
- **Export / Import de Saved Queries** en Data Export.

## Publicación

Al añadir funcionalidad, subir versión en `addon/manifest.json` **y**
`addon/manifest-firefox.json`. Generar el ZIP con el *contenido* de `addon/`
(el `manifest.json` en la raíz del ZIP).
