---
name: opencode-multi-auth-fix
description: Usar cuando aparezca "[multi-auth] No available accounts", "token_expired", "Refresh failed", "No available accounts after filtering", o cualquier error del plugin @guard22/opencode-multi-auth-codex (cuentas "personal"/"trabajo", dashboard en localhost:3434, oc-root, oc-recover-limits, oc-check-patches). También usar si el usuario dice "se rompió el multi-auth otra vez" o similar. Contiene el diagnóstico completo y el procedimiento de reparación ya investigado, para no tener que re-descubrir todo desde cero en cada sesión.
---

# Fix del plugin opencode-multi-auth-codex

Gabo usa `@guard22/opencode-multi-auth-codex@latest` para rotar entre 2
cuentas OpenAI/Codex: **personal** (gespinosaizada03@icloud.com) y
**trabajo** (yarenysespiz@gmail.com, vive oficialmente en otra computadora).
El paquete tiene bugs reales que rompen la autenticación periódicamente.
Ya se diagnosticaron y parchearon. Este documento es el procedimiento para
la próxima vez que vuelva a pasar (con o sin nuevo contexto).

## Diagnóstico rápido (primer paso, siempre)

```bash
oc-check-patches
```

Si dice "SIN PARCHE" o "FALTA archivo" en alguna copia → corre
`oc-check-patches --fix` (pide password de sudo solo si hace falta para la
copia de root) y prueba de nuevo. Esto resuelve el 90% de las recurrencias:
OpenCode reinstala el paquete desde npm de vez en cuando (usa `@latest` a
propósito, Gabo prefiere las actualizaciones del autor a fijar versión), y
esa reinstalación borra los parches sin avisar.

Si `oc-check-patches` dice que todo está OK pero el error persiste, seguir
con el resto de este documento.

## Los 3 lugares donde vive el plugin (y por qué)

OpenCode carga este paquete desde una copia distinta según el contexto de
ejecución. Los 3 deben tener los mismos 5 archivos parcheados, o el bug
vuelve en el contexto que quedó sin parchear:

1. `~/.local/lib/node_modules/@guard22/opencode-multi-auth-codex/dist/`
   — instalación npm global (usada por el dashboard `opencode-multi-auth web`).
2. `~/.cache/opencode/packages/@guard22/opencode-multi-auth-codex@latest/node_modules/@guard22/opencode-multi-auth-codex/dist/`
   — la que cargan las sesiones normales de `opencode`.
3. `~/.opencode-root-runtime/cache/opencode/packages/@guard22/opencode-multi-auth-codex@latest/node_modules/@guard22/opencode-multi-auth-codex/dist/`
   — la que carga `oc-root` (alias en `~/.mis_aliases.sh` que abre opencode
   con `sudo -E` y `XDG_CACHE_HOME`/`OPENCODE_CACHE_DIR` aislados a
   `~/.opencode-root-runtime/`, para tareas que necesitan privilegios).

Copia maestra de los archivos ya parcheados, usada por `check-patches` para
restaurar: `~/.config/opencode-multi-auth/patched-plugin/`.

Script fuente: `~/.config/opencode-multi-auth/bin/check-patches` (función
`oc-check-patches` definida en `~/.config/opencode-multi-auth/shell.zsh`).

## Los 3 bugs reales encontrados (y sus fixes)

Reportados en
https://github.com/floze-the-genius/opencode-multi-auth-codex/issues/31
(paquete npm `1.4.3`, sin fix del autor a la fecha de este documento).

### 1. `rotation.js` — `getNextAccount()` guarda una copia vieja tras un `await`
Carga el store, hace `await ensureValidToken()` (llamada de red, puede
tardar segundos), y al final hace `saveStore(store)` con la copia de ANTES
del await — si otro proceso refrescó el token mientras tanto, lo pisa.
**Fix:** recargar `loadStore()` fresco justo antes del `saveStore()` final
(2 puntos: rama force-mode y rama normal).

### 2. `limits-refresh.js` / `usage-limits.js` — cola de refresco de límites usa snapshot viejo
`refresh-queue.js` arma la cola con una lista de cuentas capturada al
inicio del ciclo; si una cuenta tarda en procesarse (concurrencia
limitada), usa un `accessToken` de minutos atrás contra la Usage API real
→ 401 genuino aunque el token en disco sea válido.
**Fix:** `refreshRateLimitsForAccount()` relee la cuenta fresca del store
antes de usar el token.

### 3. **El bug más importante, causa raíz real de la mayoría de recurrencias:**
`auth-sync.js` (`syncAuthFromOpenCode`) y `codex-auth.js`
(`syncCodexAuthFile`) leen credenciales de **archivos nativos externos**
—`~/.local/share/opencode/auth.json` (auth nativo de OpenCode, provider
`openai`) y `~/.codex/auth.json` (CLI nativo de Codex)— y las copian sin
condición hacia `accounts.json` en cada request. Esos archivos nativos
NUNCA se actualizan (el login real siempre se hace vía el dashboard
multi-auth, no vía login nativo), así que quedan congelados con el token
del primer login. Mientras ese token viejo seguía siendo válido, era
inofensivo; en cuanto expiró (vida útil ~10 días), cada sync lo
reintrodujo, revirtiendo cualquier re-auth nuevo en 30-90 segundos.
**Sub-detalle importante:** hay 3 rutas de sync (`by-token`, `by-email`,
y la de `codex-auth.js`), las 3 necesitaban el guard, no solo la primera.
**Fix:** `updateAccountIfNotStale()` — nunca sobrescribe un `expiresAt`
más reciente con uno más viejo. Log corto cuando bloquea algo:
`[multi-auth] stale sync skipped (alias)`. Ver ese mensaje es BUENA señal
(el guard está protegiendo), no un error.

### Contribuyente: sin lock entre procesos
`saveStore()` hacía read-modify-write completo sin lock cruzado entre
procesos (Gabo suele tener 3-4 sesiones `opencode` abiertas a la vez).
**Fix:** mutex de filesystem (`mkdirSync` atómico + detección de lock
huérfano) envolviendo `addAccount`/`removeAccount`/`updateAccount`/
`setActiveAlias`.

### Bug aparte: ownership root vs usuario normal (`oc-root`)
`oc-root` corre opencode con `sudo`, compartiendo el mismo
`accounts.json` que las sesiones normales (no está aislado a propósito,
Gabo necesita las mismas cuentas en ambos contextos). Cualquier escritura
hecha como root deja el archivo `root:root`, bloqueando el acceso normal
después.
**Fix:** `restoreOwnerIfRoot()` en `store.js` — si el proceso corre como
uid 0 y `SUDO_UID`/`SUDO_GID` están seteadas (sudo las exporta solo),
hace `chown` de vuelta al usuario real después de cada escritura
(archivo principal, `.bak`, `.lkg`, directorio del lock).

## Procedimiento completo si `oc-check-patches --fix` no alcanza

1. Verificar permisos: `ls -la ~/.config/opencode-multi-auth/accounts.json`
   — si es `root:root`, pedirle a Gabo que corra
   `sudo chown gabodev:gabodev ~/.config/opencode-multi-auth/accounts.json`
   (el agente normalmente no tiene sudo sin password en este host).
2. Cerrar y reabrir TODAS las sesiones `opencode` abiertas (el código
   viejo queda cacheado en memoria por proceso, reiniciar el dashboard
   solo no basta).
3. Reiniciar el dashboard (desde 2026-09-30 corre como unidad de usuario
   systemd `oc-dashboard`, no como `nohup`): `systemctl --user restart oc-dashboard`.
   Logs: `journalctl --user -u oc-dashboard -f`
   (Si la unidad no existiera —máquina recién clonada—, recrear
   `~/.config/systemd/user/oc-dashboard.service` y
   `systemctl --user enable --now oc-dashboard`.)
4. Re-auth manual desde el dashboard (`http://127.0.0.1:3434`) para la
   cuenta afectada.
5. Verificar con un monitor rápido que no vuelva a corromperse en los
   primeros 1-2 minutos:
   ```python
   import json, time
   path = '~/.config/opencode-multi-auth/accounts.json'
   last = None
   for _ in range(240):
       d = json.load(open(path))['accounts']['personal']
       snap = (d.get('expiresAt'), d.get('authInvalid'))
       if snap != last:
           print(time.time(), snap, d.get('limitError'))
           last = snap
       time.sleep(0.5)
   ```

## Reautenticar "trabajo" (vive en otra computadora)

Esa cuenta nunca se loguea nativamente en esta máquina. Si algún día hace
falta un login OAuth completo (no solo uso normal, que ya funciona vía
dashboard), el flujo usa un servidor de callback local en el puerto
1455-1459 (`http://localhost:{puerto}/auth/callback`, 5 min de timeout).
Como el navegador con la sesión de "trabajo" vive en la otra compu, hace
falta un túnel SSH desde esa computadora hacia esta:
```bash
ssh -L 1455:localhost:1455 -L 1456:localhost:1456 -L 1457:localhost:1457 \
    -L 1458:localhost:1458 -L 1459:localhost:1459 gabodev@IP_de_esta_pc
```
Luego iniciar el re-auth aquí, copiar la URL generada, abrirla en el
navegador de la otra computadora, completar el login ahí — el redirect
final viaja por el túnel de vuelta a esta máquina.

## 2026-09-30 — OpenCode v2.0.19 cambió el punto de inyección de credenciales

**Síntoma:** `The usage limit has been reached` en TODA petición `openai/*` aunque el
panel muestre cuentas sanas. `activeAlias`/`lastUsed`/`usageCount` no cambian → la
rotación no corre. Force Mode, `oc-*` y las estrategias no hacen nada.

**Causa (hubo que instrumentar el binario; no adivinar):** v2.0.19 cachea el SDK por
provider (`n.get(key) ?? runSDK(...)`) y solo dispara `aisdk.hook("sdk")` en cache miss;
el SDK de `openai` se crea antes del `setup()` del plugin, así que el `customFetch` de
rotación nunca se instalaba. Además OpenCode resuelve la credencial OAuth en su almacén
interno (`~/.local/share/opencode/opencode.db`) y adjunta su propio `Authorization`.

**Diagnóstico rápido si reaparece:**
1. `python3` sobre `accounts.json`: ¿`activeAlias`/`usageCount` cambian al pedir un modelo?
   Si NO cambian, es este problema (rotación muerta), no cuota.
2. En `opencode.db`: `SELECT value FROM credential WHERE integration_id='openai'` — el
   `metadata.accountID` es la cuenta que OpenCode usa de verdad.
3. Prueba con instrumentación temporal (`appendFileSync` a un archivo desde
   `dist/index-v2.js`) verificando si llegan los hooks `http.request`/`model.request`.

**Arreglo (ya aplicado en el fork):** `src/index-v2.ts` registra
`session.hook("model.request")` para elegir cuenta con `getNextAccount()` y **escribir su
credencial en `auth.json` + la fila `credential` de `opencode.db`** (función
`writeAccountCredentialsToOpenCode`), que es lo que OpenCode lee después del hook. Los hooks
`session.hook("http.request"/"http.response")` NO sirven: v2.0.19 solo los instala si
`has("session","http.request", providerID)` es verdadero, y para `openai` eso no pasa. Detalle completo en el manifiesto
`~/Desktop/Mantenedor/MANIFIESTO_MIGRACION_OPENCODE_MULTI_AUTH_V2.md`, sección
"Corrección 2026-09-30".

**Desplegar tras tocar el fuente:**
```bash
cd ~/Documents/Codex/2026-09-29/ho/work/guard22-opencode-multi-auth-codex && npm run build
rm -rf ~/Documents/Codex/2026-09-29/ho/outputs/opencode-multi-auth-codex-v2/dist
cp -r dist ~/Documents/Codex/2026-09-29/ho/outputs/opencode-multi-auth-codex-v2/dist
```
Sesiones nuevas cargan el plugin corregido; las instancias vivas requieren sesión nueva o
`opencode service restart`. **`opencode reload` está roto en 2.0.19**
(`ServiceUnavailableError: ue is not a function`), así que `oc-recover-limits` no activará
el cambio por sí solo.

## Cosas que NO son bugs (no perder tiempo investigando)

- **"5h limit: Remaining 0%"** con `limitStatus: success` y `authInvalid:
  false` es agotamiento real de cuota por uso, no un error. Se resetea
  solo en la hora indicada en "Reset:". No requiere acción.
- **Ver `[multi-auth] stale sync skipped (alias)`** en el dashboard o en el
  journal (`journalctl --user -u oc-dashboard`) es el guard funcionando
  correctamente, no un error.
- No fijar la versión del paquete a propósito (decisión de Gabo: prefiere
  las mejoras del autor sobre estabilidad de versión fija). El costo de
  esa decisión es que los parches se pueden perder cuando OpenCode
  reinstala — por eso existe `oc-check-patches`.

