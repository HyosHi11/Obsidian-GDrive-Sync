# Obsidian Gdrive Sync — Plugin Overview

> Version 0.1.0 · Obsidian plugin `obsidian-gdrive-sync` · TypeScript + esbuild · HTTP via `ky`
> Build: `npm run dev` / `npm run build` (runs `tsc --noEmit` then esbuild)

---

## 1. Main goals

The plugin keeps a local Obsidian vault and a Google Drive folder tree mutually
in sync, without a server:

1. **Bidirectional sync, split by moment.** *Starting a sync pushes.* The plugin
   checks the local vault against the Drive tree and uploads the files and
   folders whose local **date modified is newer** than their Drive counterpart,
   together with local deletions and renames. *Starting the app pulls.* Drive
   files/folders whose date modified is newer than the last-sync watermark are
   downloaded and applied automatically (see section 2.2).
2. **Keep Obsidian state intact.** Remote renames are applied with
   `fileManager.renameFile` (not delete + create) so backlinks, history and the
   file cache survive.
3. **Never silently lose user work.** Local edits made while a sync runs are
   queued and pushed later; remote deletions do not erase a file that has
   unsynced local edits.
4. **Sync Obsidian configuration too.** `.obsidian` config files and a whitelist
   of plugin files are synced so plugins/themes/snippets follow the vault across
   devices. The OAuth secrets are deliberately *not* uploaded.
5. **Isolate vaults.** Every Drive object is tagged with a `vaultId`; several
   vaults can share one Google account without mixing file trees.
6. **Safe-by-default UX.** A confirmation modal before a push (optional), a
   destructive-warning modal before a reset, a ribbon button that can either
   sync immediately or open a menu, and notices for every outcome.
7. **Robust auth.** OAuth Device Flow (no local redirect server), mutex-protected
   token refresh, and automatic retry once on HTTP 401.

---

## 2. High-level design

### 2.1 Sync flow — push newer local files & folders to Drive

Starting a sync only *pushes*. Before uploading, the plugin fetches the current
`modifiedTime` of every pending path from Google Drive and compares it with the
local file's `stat.mtime`:

- **local newer** → the file/folder is uploaded (created or updated);
- **Drive newer or equal** → it is **not** pushed (Drive already holds that
  version or a newer one); the local copy is skipped and left for the next pull.

```
runSync() ─► push()
             ├─ (optional) ConfirmPushModal        # if confirmPush && !skipConfirm
             ├─ startSync()                        # syncing=true, notice, internet check
             ├─ fetch Drive modifiedTime per path  # the "latest modified date" source
             ├─ push newer items: deletes → renames → creates → modifies
             ├─ sync config files (.obsidian + plugin whitelist)
             ├─ cleanup succeeded operations, save settings
             └─ endSync(notice, false, no failures) # commit watermark only on success
```

Deletions and renames flow upward the same way: a local item that no longer
exists on Drive is deleted there, and a local rename patches the existing Drive
object instead of re-uploading it. A new local file whose path already exists on
Drive is updated in place rather than duplicated. The push reports
`"Sync complete!"` only when nothing failed; otherwise it shows
`"Sync incomplete: N item(s) could not be pushed and will be retried."`

The reverse direction — newer files and folders coming **down** from Drive — is
handled automatically when Obsidian starts; see section 2.2 *Automatic pull on
app startup*.

### 2.2 Automatic pull on app startup

When Obsidian starts, the plugin **pulls automatically** so the vault catches up
with everything that changed on Drive while this device was closed or offline.

- **Trigger:** `onload()` (and `runInitialSync()` right after an account is
  connected) checks the connection, then runs `pull(this, true)` followed by
  `endSync()`.
- **Date rule:** the vault is brought up to date **by date modified**. Drive
  files/folders whose `modifiedTime` is **newer than `lastSyncedAt`** are
  downloaded and applied locally (created, or overwritten with Drive's mtime);
  on a clean finish the watermark advances to the sync time.
- **Deletions & renames:** applied from the Drive changes feed, so items removed
  or renamed on another device do not linger locally.
- **Newest write wins:** if a local file still has an unsynced edit, its
  `stat.mtime` is compared with the Drive copy. A newer local edit is kept and
  pushed by the next sync, while a newer Drive copy is downloaded and the stale
  local edit is discarded. When the two cannot be compared, the local edit is
  kept (never silently overwritten).
- **Failure:** when offline the startup pull is skipped; a Drive/HTTP error is
  logged, `pendingChangesToken` is cleared and `syncing` reset in `finally` (the
  plugin stays loaded and later syncs still work).

### 2.3 What each Drive object carries

Every file/folder the plugin creates has Drive `properties`:

| property   | value                                             | purpose |
|------------|---------------------------------------------------|---------|
| `vault`    | vault name                                        | human-readable / legacy |
| `vaultId`  | random UUID per vault (`settings.vaultId`)        | scopes every query so vaults don't mix |
| `path`     | vault-relative path                               | identity mapping between Drive and vault |
| `obsidian` | `"vault"` (root folder only)                      | locate the vault root |
| `config`   | `"true"` on `.obsidian` + whitelisted plugin files| config reconciliation |

### 2.4 State kept in `data.json`

| field | meaning |
|-------|---------|
| `vaultId` | UUID scoping this vault's Drive tree |
| `clientId`, `clientSecret` | OAuth client (device flow) |
| `refreshToken` | long-lived token; never uploaded to Drive |
| `operations` | pending changes: `create` / `delete` / `modify` / `rename`, keyed by vault path |
| `renames` | `newPath → originalPath` for pending renames |
| `driveIdToPath` | Drive file id → vault path (the id map used by push) |
| `lastSyncedAt` | watermark; remote files newer than this are pulled |
| `changesToken` | Google Drive changes-feed page token |
| `vaultIdMigrated` | one-time flag for legacy-tree adoption |
| `syncOnSave`, `syncOnSaveDelay`, `confirmPush`, `ribbonAction` | UX settings |

### 2.5 Directory / file map

| path | role |
|------|------|
| `main.ts` | Plugin entry point: lifecycle, state, sync orchestration, vault write helpers, settings tab |
| `deviceAuthModal.ts` | UI for the OAuth Device Flow |
| `helpers/drive.ts` | Google Drive REST client (queries, CRUD, changes feed, config discovery, batching helpers) |
| `helpers/pull.ts` | Download/apply Drive state to the vault |
| `helpers/push.ts` | Upload/apply local state to Drive (+ confirmation/undo modals) |
| `helpers/reset.ts` | Destructive "make local mirror Drive" operation (+ confirm modal) |
| `helpers/ky.ts` | `ky` instance, OAuth request hooks, 401 retry |
| `helpers/deviceAuth.ts` | Device Flow primitives (device code, poll, refresh) |
| `helpers/util.ts` | Cross-platform helpers: UUID fallback + mtime normalisation |
| `helpers/googleOAuthConfig.ts` | Legacy hard-coded credentials file (unused by runtime; see notes) |
| `helpers/googleOAuthConfig.example.ts` | Placeholder for the above |
| `backup/` | Snapshot of an older revision (not compiled/used) |

---

## 3. Function reference

Legend: **Purpose** — what it is for · **How** — how it works · **Success** —
what a good outcome looks like · **Failure** — what can go wrong and how the
failure is surfaced.

---

## 3.1 `main.ts` — lifecycle & sync orchestration

### `ObsidianGoogleDrive` (class)

Fields: `settings`, `accessToken {token, expiresAt}`, `drive` (Drive client
bound to `this`), `ribbonIcon`, `syncing`, `pendingChangesToken`,
`internalOperationCount`, `refreshPromise`, `syncFeaturesRegistered`,
`debouncedSyncOnSave`.

**`isApplyingRemoteChange(): boolean`**
- **Purpose:** Distinguish "the plugin is writing to the vault because of a
  pull/reset" from "the user edited the vault".
- **How:** Returns `internalOperationCount > 0`. Obsidian fires vault events
  synchronously from inside `vault.createX/modifyX/trashFile`, so a depth counter
  around those calls reliably suppresses the events they generate.
- **Success:** Vault events caused by the sync engine are ignored by the
  handlers; genuine user edits are recorded even while `syncing === true`.
- **Failure:** If Obsidian ever delivered vault events asynchronously the counter
  would already be back to 0 and an internal write could be mis-recorded; the
  per-call save/restore of `settings.operations` in the write helpers is the
  second line of defence.

**`runInternalOperation<T>(operation): Promise<T>`**
- **Purpose:** Mark a vault mutation as plugin-initiated.
- **How:** Increments the counter, `await`s the callback, decrements in
  `finally`.
- **Success:** The mutation runs normally and the event handlers skip it.
- **Failure:** Exceptions propagate unchanged (the counter is still restored).

**`onload()`**
- **Purpose:** Load settings, register commands/events, resume sync on startup.
- **How:** `loadSettings()` → `updateSyncOnSaveDebounce()` → setting tab →
  `registerSyncFeatures()` → if credentials are incomplete show a notice and
  stop → otherwise `checkConnection()` and, if online, set `syncing`, run
  `pull(this, true)`, then `endSync()`.
- **Success:** Plugin is usable; if already configured and online, the vault is
  brought up to date at startup by the automatic pull (section 2.2).
- **Failure:** Missing credentials → onboarding notice (no sync). Startup pull
  error → logged, `pendingChangesToken` cleared, `syncing` reset in `finally`
  (the plugin stays loaded, later syncs still work).

**`onunload()`**
- **Purpose:** Persist settings when the plugin unloads.
- **How:** `return this.saveSettings()`.
- **Success:** `data.json` contains the latest state.
- **Failure:** A failed write surfaces as a rejected promise; in-memory state is
  never corrupted.

**`updateSyncOnSaveDebounce()`**
- **Purpose:** Build the debounced "sync after edit" trigger.
- **How:** `debounce(fn, max(500, delaySeconds*1000), resetTimer=true)`. The
  callback no-ops unless `syncOnSave` and a refresh token exist; if `syncing` it
  re-arms itself; otherwise calls `runSync({silent, skipConfirm})`.
- **Success:** A burst of edits results in one background sync after the delay.
- **Failure:** During a long sync the timer keeps re-arming (no overlapping
  syncs).

**`registerSyncFeatures()`**
- **Purpose:** Register ribbon/commands/events exactly once.
- **How:** Guarded by `syncFeaturesRegistered`. Adds the ribbon icon, commands
  (`sync`, `push`, `pull`, `reset`), a `quit` settings save, and vault events
  (`create` on layout-ready, plus `delete`/`modify`/`rename`).
- **Success:** UI and listeners exist; handlers are bound with `this`.
- **Failure:** Repeat calls are no-ops (safe; it is re-called after first
  connect).

**`registerRibbonIcon()`**
- **Purpose:** Create the ribbon button and its context menu.
- **How:** `addRibbonIcon("refresh-cw", …)`. Left-click runs `runSync()` or opens
  the menu per `settings.ribbonAction`; right-click / `contextmenu` opens the
  menu.
- **Success:** Exactly one icon; actions dispatch correctly.
- **Failure:** Guarded by `if (this.ribbonIcon) return`, so it never duplicates.

**`showSyncMenu(event)`**
- **Purpose:** Ribbon context menu.
- **How:** Builds a `Menu` with Sync now / Pull / Push / Reset and shows it at
  the mouse event.
- **Success:** Menu with four actions.
- **Failure:** Returns immediately while `syncing` to avoid competing runs.

**`runSync(options?: {silent?, skipConfirm?})`**
- **Purpose:** Single entry point for every "sync" interaction.
- **How:** Rejects if already `syncing` (notice unless silent) or credentials are
  missing; otherwise delegates to `push(this, options)` (push always pulls
  first).
- **Success:** A full pull+push cycle.
- **Failure:** Busy/misconfigured → user-visible notice (suppressed in silent
  mode); actual sync errors are handled inside `push`.

**`startSync(): Promise<Notice>`**
- **Purpose:** Begin a sync session.
- **How:** Verifies credentials and `checkConnection()`; adds the spinner class,
  sets `syncing = true`, and returns a sticky `Notice("Syncing (0%)")` (timeout
  0) that callers update with progress.
- **Success:** Callers get a progress notice; other code sees `syncing === true`.
- **Failure:** Throws an `Error` with a user-friendly message (missing
  credentials / offline). It throws *before* setting `syncing`, so the busy flag
  is never left stuck.

**`endSync(syncNotice?, retainConfigChanges = true, markSynced = true)`**
- **Purpose:** Finish a session and commit sync bookkeeping.
- **How:** If `retainConfigChanges`, fetch config files changed since the
  watermark and rewrite them with `mtime = now` (keep them locally "dirty");
  ensure `changesToken` exists; adopt `pendingChangesToken`; if `markSynced`,
  advance `lastSyncedAt = Date.now()`; save settings. `finally` always clears
  `pendingChangesToken`, removes the spinner and clears `syncing`.
- **Success:** Watermark/token saved, spinner cleared, session ends cleanly.
- **Failure:** A config-fetch error throws out of `endSync`; `finally` still
  clears the busy state. When `markSynced === false` (a partially failed push) the
  watermark is intentionally *not* advanced, so remote changes made during the
  failed run remain visible to the next pull.

**`runInitialSync()`**
- **Purpose:** First sync right after connecting an account.
- **How:** `checkConnection()` → `syncing = true` → `pull(this, true)` →
  `endSync()`.
- **Success:** Existing Drive content is downloaded (local files were pre-queued
  as `create` by the connect flow).
- **Failure:** Offline → silent return. Pull error → logged, flags reset in
  `finally`.

**`disconnectDrive()`**
- **Purpose:** Forget the Google account for this vault.
- **How:** Clears `refreshToken`, `changesToken`, `driveIdToPath`, `renames`,
  `operations` and the in-memory `accessToken`; saves settings.
- **Success:** The plugin returns to the onboarding state.
- **Failure:** None locally. Drive data is intentionally untouched; reconnecting
  rediscovers the same tree through `vaultId`.

---

## 3.2 `main.ts` — settings, auth & persistence

**`loadSettings()`**
- **Purpose:** Load `data.json` merged over defaults.
- **How:** `Object.assign({}, DEFAULT_SETTINGS, loaded, {operations, renames,
  driveIdToPath})` where the three maps are copied so a partial/older `data.json`
  can never alias (and mutate) `DEFAULT_SETTINGS`. Generates a `vaultId` if
  missing and saves.
- **Success:** `this.settings` is complete and safe to mutate.
- **Failure:** A malformed `data.json` yields defaults; missing maps become empty
  objects.

**`saveSettings()`**
- **Purpose:** Persist in-memory settings.
- **How:** `return this.saveData(this.settings)`.
- **Success:** `data.json` matches memory.
- **Failure:** Rejections propagate to the caller; in-memory state is unchanged.

**`getSettingsFilePath()`**
- **Purpose:** Vault path of this plugin's own `data.json`.
- **How:** `configDir + "/plugins/" + manifest.id + "/data.json"`.
- **Success:** Correct path for config reconciliation.
- **Failure:** None.

**`getSettingsForSync()`**
- **Purpose:** Produce the settings snapshot uploaded to Drive.
- **How:** Shallow copy, then deletes `clientId`, `clientSecret` **and
  `refreshToken`** so no OAuth secret is ever uploaded.
- **Success:** Safe snapshot containing data + queue state.
- **Failure:** None.

**`mergeSyncedSettings(content)`**
- **Purpose:** Merge a downloaded settings file with this device's secrets.
- **How:** Parses JSON, spreads the synced settings, then overrides
  `clientId`, `clientSecret` and `refreshToken` with the local values. Falls back
  to the raw content if parsing fails.
- **Success:** Device keeps its own credentials/token while adopting synced data.
- **Failure:** Unparseable JSON → raw bytes written unchanged.

**`refreshAccessToken(): Promise<boolean>`**
- **Purpose:** Exchange the refresh token for an access token.
- **How:** Mutex: if `refreshPromise` is in flight it is returned, so concurrent
  callers share one HTTP request. On success stores
  `{token, expiresAt: now + expires_in*1000}`; on error logs and shows a notice;
  `finally` clears the mutex.
- **Success:** `true` and a fresh `accessToken`.
- **Failure:** `false` when credentials are missing or the request fails;
  callers degrade to unauthenticated requests (which then 401 and are retried
  once).

**`getOAuthCredentials(): OAuthCredentials`**
- **Purpose:** Bundle `clientId`/`clientSecret` for the device-flow helpers.
- **How:** Returns `{clientId, clientSecret}` from settings.
- **Success:** Always returns an object (possibly empty strings).
- **Failure:** None; `startSync()`/the modal validate non-empty values.

---

## 3.3 `main.ts` — vault event handlers

All four handlers start with `if (this.isApplyingRemoteChange()) return;`, so
plugin-initiated writes are never queued, while **user edits made during a sync
are still recorded**. Each ends with `debouncedSaveSettings()` and (if
`syncOnSave`) `debouncedSyncOnSave()`.

**`handleCreate(file)`**
- **Purpose:** Record a newly created vault item.
- **How:** If the path is pending deletion, a recreated *file* becomes `modify`
  (its Drive counterpart may still exist) and a recreated *folder* simply clears
  the delete; otherwise queues `create`.
- **Success:** New item is queued for upload; a "recreate after delete" does not
  produce a duplicate on Drive.
- **Failure:** None; the operation map is always left consistent.

**`handleDelete(file)`**
- **Purpose:** Record a deletion, accounting for pending renames.
- **How:** Drops any `renames[path]`; if the item was still an unsynced `create`
  it is just discarded locally, otherwise `delete` is queued on the *original*
  Drive path (from `renames`) so the correct remote object is removed.
- **Success:** Remote counterpart of the deleted item will be deleted on push.
- **Failure:** None.

**`handleModify(file)`**
- **Purpose:** Record content changes.
- **How:** Ignores non-files. Keeps `create` as-is; turns anything else except
  `modify` into `modify` (so a renamed-and-edited file keeps its `renames`
  metadata while its content is uploaded).
- **Success:** Edits are queued exactly once.
- **Failure:** None.

**`handleRename(file, oldPath)`**
- **Purpose:** Track a rename without losing Drive identity/history.
- **How:** Case A — the item was a never-synced `create` (no Drive id): move the
  `create` op to the new path and re-prefix child operations for folders. Case B —
  the item exists on Drive: record `renames[newPath] = originalPath`, repoint
  `driveIdToPath[id]`, move the old operation to the new path (`modify` stays
  `modify`, else `rename`), and re-prefix `driveIdToPath`/`renames`/`operations`
  for folder descendants.
- **Success:** Push will rename the existing Drive object (metadata-only) instead
  of re-uploading.
- **Failure:** A rename of a Drive object with no recorded id lands in Case B and
  is retried/reconciled on the next push.

---

## 3.4 `main.ts` — vault write helpers

Every helper snapshots `settings.operations[path]` before the mutation and
restores it afterwards, and wraps the mutation in `runInternalOperation()` so the
resulting vault events are not treated as user edits.

**`createFolder(path)`** — `vault.createFolder`. **Success:** folder exists,
operation restored. **Failure:** throws if the folder already exists (callers in
pull/reset catch and report).

**`createFile(path, content, modificationDate?)`** — normalises the date, then
`vault.createBinary` with `mtime`. **Success:** file created with the remote
timestamp. **Failure:** throws on I/O error; the caller treats it as a sync
failure.

**`modifyFile(file, content, modificationDate?)`** — `vault.modifyBinary` with
`mtime`. **Success:** local content/mtime replaced by the Drive version.
**Failure:** throws on I/O error.

**`upsertFile(file, content, modificationDate?)`** — writes through the raw
adapter (`adapter.writeBinary`) and therefore creates *or* overwrites without
requiring an indexed `TFile`. **Success:** byte-identical write for files the
vault index does not yet know about. **Failure:** throws on I/O error.

**`deleteFile(file): Promise<boolean>`** — if the file still exists,
`fileManager.trashFile` (respecting the user's trash setting) wrapped as an
internal operation; then removes any pending operation for it. **Success:**
`true` (including the "already gone" case). **Failure:** logs a warning and
returns `false`, which callers treat as a failed deletion.

---

## 3.5 `helpers/drive.ts` — Google Drive client

### Query-building utilities

**`getErrorStatus(error): number | undefined`**
- **Purpose:** Extract an HTTP status from a caught `ky` `HTTPError`.
- **How:** Structural check for `error.response.status` (no `any`).
- **Success:** The numeric status.
- **Failure:** `undefined` for non-HTTP errors (network failures, aborts).

**`escapeQuery(str)`** — escapes `\` and `'` for Drive query strings.
**Success:** Safe literal. **Failure:** none.

**`stringSearchToQuery(search)`** — converts `string | {contains} | {not}` into
`='…'`, ` contains '…'` or `!='…'`. **Success:** correct Drive operator.
**Failure:** returns `undefined` for an unknown shape (never happens with the
typed inputs).

**`queryHandlers`** — maps `name/mimeType/parent/starred/query/properties/
modifiedTime` to Drive query fragments (`properties` becomes one
`properties has { key=… and value=… }` clause per entry).

**`fileListToMap(files)`** — `[{id,name}] → {name: id}` convenience helper.

### `getDriveClient(t)` factory

Returns the Drive API surface, all bound to the plugin instance. Internally it
builds a `ky` instance via `getDriveKy(t)` and closes over these helpers.

**`getQuery(matches?)`**
- **Purpose:** Build the Drive `q=` expression.
- **How:** Always ANDs `trashed=false and properties has {key='vaultId',
  value='<this vault>'}`; each match object becomes a parenthesised clause whose
  fields are ANDed, and multiple matches are ORed.
- **Success:** URL-encoded query scoped to this vault.
- **Failure:** Empty/undefined matches fall back to the vault clause alone.

**`paginateFiles({matches, pageToken, order, pageSize, include})`**
- **Purpose:** One page of `files.list`.
- **How:** Requests `fields=nextPageToken,files(...)` and adds `orderBy=name`
  (asc/desc) unless a `query` (full-text) match is present, plus an optional
  `pageToken`.
- **Success:** `DriveFilesResponse`.
- **Failure:** HTTP error → throws (caught by `withErrorHandling` at the client
  boundary).

**`searchFiles({matches, order, include}, includeObsidian = false)`**
- **Purpose:** High-level, fully-paginated search.
- **How:** Calls `paginateFiles` with `pageSize: 1000` and follows
  `nextPageToken` until exhausted. Unless `includeObsidian` is set, filters out
  the root folder (`properties.obsidian === "vault"`).
- **Success:** `FileMetadata[]` (possibly empty).
- **Failure:** returns `undefined` if any page fails (or the page resolver
  throws, caught by the wrapper) so callers can show an error.

**`getRootFolderId()`**
- **Purpose:** Find (or lazily create) the vault's Drive root folder.
- **How:** Searches for `obsidian=vault` **and** the current `vaultId`. If none
  exists, `POST`s a folder named after the vault with
  `properties {obsidian, vault, vaultId}`.
- **Success:** the root folder id.
- **Failure:** returns `undefined` on HTTP failure or if creation returns no id;
  callers then fail the upload/folder-creation they were performing.

> Legacy upgrade path: trees created before `vaultId` scoping are adopted by
> `ensureVaultMigrated()` (below) before this runs, so existing users do not get a
> duplicate tree.

### Drive write operations

**`createFolder({name, parent, description, properties, modifiedTime})`**
- **Purpose:** Create a Drive folder inside the vault tree.
- **How:** Resolves the vault root when no `parent` is given; always injects
  `properties.vault` (vault name) and `properties.vaultId`; `POST drive/v3/files`
  with `mimeType = application/vnd.google-apps.folder`.
- **Success:** new folder id.
- **Failure:** returns `undefined` if the parent/root can't be resolved or the
  request fails (wrapped at the client boundary).

**`getMimeType(filename)`**
- **Purpose:** Best-effort MIME type for uploads.
- **How:** Maps common extensions (`md`, `txt`, `json`, images, `pdf`, `css`,
  `js`); defaults to `application/octet-stream`.
- **Success:** a usable content type.
- **Failure:** unknown/no extension → `octet-stream` (files still upload).

**`uploadFile(file, name, parent?, metadata?)`**
- **Purpose:** Create a new file with content + metadata in one request.
- **How:** Resolves the root when `parent` is missing; injects `vault`/`vaultId`
  properties; builds a `multipart/related` body (JSON metadata part + binary
  part) and `POST`s `upload/drive/v3/files?uploadType=multipart&fields=id`.
- **Success:** new Drive file id.
- **Failure:** returns `undefined` on unresolved parent or HTTP failure; callers
  mark the operation failed and keep it queued.

**`updateFile(id, newContent, newMetadata = {}, params?)`**
- **Purpose:** Replace content + metadata of an existing file.
- **How:** Injects `vault` **and `vaultId`** (kept consistent with
  `uploadFile`/`updateFileMetadata`); multipart `PATCH` with optional
  `addParents`/`removeParents` (used for move-on-rename).
- **Success:** the file's id.
- **Failure:** throws immediately for a missing id; returns `undefined` on HTTP
  failure. Modify handling then re-uploads as a new file when appropriate.

**`updateFileMetadata(id, metadata, params?)`**
- **Purpose:** Metadata-only update (rename / move / re-tag).
- **How:** Injects `vault`/`vaultId`; `PATCH drive/v3/files/{id}` with optional
  `addParents`/`removeParents`.
- **Success:** the file's id.
- **Failure:** returns `undefined` on HTTP failure → the caller queues the
  operation for retry.

**`listFilesByRawQuery(rawQuery)`**
- **Purpose:** List files for a raw Drive query, *bypassing* `vaultId` scoping.
- **How:** Fully paginated `files.list` (`pageSize 1000`, fields include
  `properties`).
- **Success:** `{files: FileMetadata[]}`.
- **Failure:** returns `undefined` if any page fails. Only used by the migration
  below.

**`ensureVaultMigrated()`**
- **Purpose:** One-time adoption of a Drive tree created before `vaultId`
  scoping existed, preventing a duplicate tree on upgrade.
- **How:** Short-circuits on `settings.vaultIdMigrated`. Otherwise: (1) if a
  `vaultId`-scoped root already exists, set the flag and return; (2) look for a
  legacy root (`obsidian=vault` + `vault=<name>`); if none, set the flag (nothing
  to adopt) and return; (3) list every file tagged with `vault=<name>`; (4) stamp
  `vaultId` on the root and all of them via `updateFileMetadata` (batches of 10);
  (5) set the flag and save.
- **Success:** `true`. Existing files become visible to all scoped queries and
  keep their ids, so `driveIdToPath` stays valid.
- **Failure:** `false` on any HTTP error, which makes `pull()` abort with a
  notice rather than risk creating a duplicate tree. A partial stamp simply
  retries next run (flag not set).

### Drive read / delete operations

**`deleteFile(id)`**
- **Purpose:** Permanently delete one Drive file.
- **How:** `DELETE drive/v3/files/{id}`; treats HTTP 404 as success.
- **Success:** `true`.
- **Failure:** `false` for any other HTTP/network error (caller keeps the
  operation queued).

**`getFile(id)`** — raw `ky` response for `files.get?alt=media` (callers chain
`.arrayBuffer()`). Never wrapped, because it is chainable rather than resolved.
**Success:** a response. **Failure:** throws to the caller.

**`getFileContent(id)`**
- **Purpose:** Non-throwing byte fetch.
- **How:** `await getFile(id).arrayBuffer()` in a `try/catch`.
- **Success:** `ArrayBuffer`.
- **Failure:** `undefined` (caller shows "An error occurred fetching Google Drive
  files." and fails the item).

**`getFileMetadata(id)`** — `files.get` with an explicit field list.
**Success:** `FileMetadata`. **Failure:** throws (wrapper → `undefined`).

**`idFromPath(path)`** — searches by `properties.path`, returns the first id or
`undefined`.

**`idsFromPaths(paths)`** — batch lookup returning `[{id, path}]`; `undefined` on
error.

**`batchDelete(ids)`**
- **Purpose:** Delete many files with per-id results.
- **How:** runs `deleteFile`-style deletions through `batchAsyncs` (10 at a
  time), recording `true` on success or on 404.
- **Success:** `Record<id, boolean>` (empty object for an empty input).
- **Failure:** failed ids are `false` and logged; callers keep those operations
  queued.

**`getChangesStartToken()`**
- **Purpose:** Fetch a fresh changes-feed page token.
- **How:** `GET drive/v3/changes/startPageToken`.
- **Success:** the token string.
- **Failure:** `undefined` on error.

**`getChanges(startToken)`**
- **Purpose:** Read the Drive changes feed since `startToken`.
- **How:** With no token, fetches a start token and returns
  `{changes: [], newStartPageToken, tokenRenewed: true}`. Otherwise pages through
  `drive/v3/changes` (`includeRemoved`, `supportsAllDrives`,
  `includeItemsFromAllDrives`, `pageSize 1000`), accumulating changes and the
  final `newStartPageToken`.
- **Success:** `{changes, newStartPageToken, tokenRenewed: false}`; the caller
  stores `newStartPageToken` as `pendingChangesToken`.
- **Failure:** only HTTP **400/404/410** are treated as "token expired": a new
  start token is fetched and `tokenRenewed: true` is returned (pull then does a
  full id reconciliation). **Any other error is rethrown**, so the client wrapper
  resolves `undefined` and the sync fails loudly instead of silently skipping
  unseen changes. A failed follow-up page also throws → `undefined`.

### Bulk local deletion

**`deleteFilesMinimumOperations(files: TAbstractFile[])`**
- **Purpose:** Delete a set of local files/folders with the fewest operations.
- **How:** Processes folders shallowest-first via `t.deleteFile` (Obsidian's
  trash handling), pruning each deleted folder's descendants from the work list,
  then deletes the remaining files.
- **Success:** `Record<path, boolean>` with every entry `true`.
- **Failure:** a failed folder/file is `false`; descendants are skipped once
  their parent folder is handled. Callers require *all* results to be `true`.

### Config discovery

**`getConfigFilesToSync()`**
- **Purpose:** Find config files that changed locally since the watermark.
- **How:** Lists `configDir` and `configDir/plugins`; includes top-level files
  whose `mtime > lastSyncedAt` excluding `graph.json`, `workspace.json`,
  `workspace-mobile.json`; includes plugin files named `manifest.json`,
  `styles.css`, `main.js`, `data.json` under the same mtime rule.
- **Success:** `string[]` of vault-relative paths.
- **Failure:** throws (wrapper → `undefined`); `push`/`endSync` then report "An
  error occurred fetching Google Drive config files." and abort cleanly.

### Error-handling wrapper and exported client surface

**`withErrorHandling(fn)`**
- **Purpose:** Preserve the codebase-wide contract that Drive helpers resolve to
  `undefined` on failure instead of throwing.
- **How:** Returns an `async` wrapper with `try { return await fn(...) } catch {
  return undefined }`.
- **Success:** every wrapped call resolves (value or `undefined`).
- **Failure:** errors are swallowed *by design* at this boundary; callers must
  check for `undefined`/falsy. `getFile` is deliberately **not** wrapped (it must
  stay chainable); use `getFileContent` for safe reads.

The returned object exposes: `paginateFiles`, `searchFiles`, `getRootFolderId`,
`createFolder`, `uploadFile`, `updateFile`, `updateFileMetadata`, `deleteFile`,
`getFile`, `getFileContent`, `getFileMetadata`, `idFromPath`, `idsFromPaths`,
`getChangesStartToken`, `getChanges`, `batchDelete`, `checkConnection`,
`deleteFilesMinimumOperations`, `getConfigFilesToSync`, `ensureVaultMigrated`.

### Module-level utilities

**`checkConnection()`** — returns `false` immediately when `navigator.onLine` is
`false`; otherwise `HEAD`s the Drive discovery document; on fetch error falls back
to a `no-cors` `generate_204` probe. **Success:** `true`. **Failure:** `false`
(used by `startSync`, which then throws a friendly offline error).

**`batchAsyncs(requests, batchSize = 10)`** — runs thunks in sequential batches
of `Promise.all`, preserving order. **Success:** flattened results.
**Failure:** a rejected thunk rejects the batch (callers rely on wrapped Drive
calls that never reject).

**`getSyncMessage(min, max, completed, total)`** — formats
`"Syncing (n%)"` from a progress range. **Failure:** `total === 0` yields `NaN`
but is never called with an empty set.

**`fileNameFromPath(path)`** — last `/`-segment. **`foldersToBatches(folders)`**
— groups folder paths/`TFolder`s into arrays by depth (shallowest first) so
parents are created/deleted before children. **Failure:** empty input or invalid
depth returns `[]`.

---

## 3.6 `helpers/pull.ts` — applying Drive state locally

### `pull(t, silenceNotices?)`

**Purpose:** Download and apply everything that changed on Drive since the last
sync, and delete local files whose Drive counterparts disappeared.

**How (ordered):**
1. If not silent: bail out when `syncing`; otherwise `startSync()` (on error show
   a notice and return).
2. Snapshot `driveIdToPath` and `operations` for rollback; define
   `restorePullState`.
3. Refresh the access token if needed, then `ensureVaultMigrated()` (legacy
   adoption).
4. `searchFiles({modifiedTime > lastSyncedAt})` → `recentlyModified`.
5. `getChanges(changesToken)` → deletions/trashes; stash
   `pendingChangesToken`.
6. If the token was renewed, reconcile Drive ids against the local id map and
   treat missing ids as deletions.
7. Build the `deletions` list (skipping items whose delete is already pending).
8. Short-circuit "You're up to date!" when nothing changed.
9. Apply **remote renames** (`fileManager.renameFile`) and migrate
   operations/`driveIdToPath`/`renames` for renamed folders.
10. `updateMap()` rebuilds `driveIdToPath`.
11. `deleteFiles()` — remove vanished items (preserving files with pending local
    edits).
12. `upsertFiles()` — create folders deepest-last and download files.
13. `deleteConfigs()` — trash local config files removed on Drive.
14. Clean up deleted ids, finish (`endSync`) and notice.

**Success:** returns `true` (silent path returns `true` as well once changes were
applied); vault mirrors Drive; `pendingChangesToken` committed via `endSync`.
**Failure:** returns `false` on any Drive error (with a notice), rolling back via
`restorePullState()`. Remote renames that cannot be applied no longer abort the
whole pull: the rest is applied, a warning notice is shown (non-silent), the
watermark is **not** advanced so the rename is retried, and `true` is returned.
The `finally` block ends the sync session only for non-silent calls.

### Inner helpers

**`restorePullState()`** — restores the `driveIdToPath` snapshot and the
operations map, **merging in** operations recorded by user edits during the pull
(only pre-existing keys are rolled back). Clears `pendingChangesToken`.
**Success:** no partial pull state; concurrent user edits preserved.
**Failure:** none.

**`renamePrefixes(oldPath, newPath)`** — re-prefixes `pathToId`, `operations`
and `renames` entries under a renamed Drive folder. **Success:** descendants
follow their parent's new path. **Failure:** none (pure in-memory).

**`updateMap()`** — rebuilds `driveIdToPath` from the path→id map for every
`recentlyModified` entry, skipping renames that failed. **Success:** id map
reflects new paths. **Failure:** failed-rename ids keep their old mapping so the
rename is retried.

**`deleteFiles()`**
- **Purpose:** Delete local files/folders whose Drive versions were removed.
- **How:** Files with a pending local `modify` are preserved and re-queued as
  `create` (local edit wins); folders are only deleted when *all* their local
  children are also being deleted; the rest go through
  `deleteFilesMinimumOperations`.
- **Success:** every result `true` → `true`.
- **Failure:** any failed deletion → `false` (pull aborts with that file's
  operation left queued).

**`upsertFiles()`**
- **Purpose:** Create/refresh local copies of new & modified Drive files.
- **How:** Folders are batched by depth and created unless they already exist;
  files are fetched via `getFileContent` in batches. For a file with a pending
  local `modify`, the local `stat.mtime` is compared with the Drive
  `modifiedTime`: the local edit is kept when it is newer (or cannot be
  compared), otherwise the stale local edit is dropped and the Drive version is
  applied. A pending `create` becomes `modify` (the local copy is newer by
  definition). Files whose path is the *original* of a pending local rename are
  skipped so the old path is not resurrected. The plugin's own `data.json` is
  merged with `mergeSyncedSettings` so secrets are preserved.
- **Success:** `undefined`; local files match Drive content/mtime.
- **Failure:** returns `false` on the first content fetch failure (after a
  notice), aborting the pull.

**`deleteConfigs()`**
- **Purpose:** Remove local config files/folders deleted on Drive but not
  indexed by the vault (so `deleteFiles()` did not see them).
- **How:** Resolves deleted ids to paths on disk via `adapter.stat`; uses the
  user's Obsidian trash option (`system`/`local`) when set, otherwise
  `adapter.remove`/`rmdir` deepest-last.
- **Success:** `true`.
- **Failure:** caught, logged and returns `false` → pull aborts.

---

## 3.7 `helpers/push.ts` — uploading local state

### `ConfirmPushModal` (shown when `confirmPush` is on)

**`constructor(t, initialOperations, proceed)`**
- **Purpose:** Let the user review — and selectively drop — pending operations
  before they are pushed.
- **How:** Renders each `[path, op]` alphabetically. A `delete` whose ancestor is
  also being deleted is hidden (covered by the parent). Each row has a trash
  button that opens `ConfirmUndoModal` for that entry and its descendants; on
  confirm the nested operations are removed from `settings.operations` and the
  list re-renders.
- **Success:** `proceed(true)` from the Confirm button; the surviving operations
  are pushed.
- **Failure:** Cancel / closing calls `proceed(false)` (push aborts). If every
  operation is undone the modal closes and push aborts (nothing to do).

**`onClose()`** — resolves the pending promise with `false` if the user closed
without confirming (the already-resolved true wins when Confirm was used).

### `ConfirmUndoModal` (per-entry undo of one operation)

**`constructor(t, operation, files, proceed)`** — shows the affected paths and a
Confirm/Cancel pair. `filePathToId` is snapshotted for metadata lookups.

**`onClose()`** — resolves `false` unless Confirm already resolved `true`.

**`handleDelete(paths)`**
- **Purpose:** Undo a remote deletion by restoring the files from Drive.
- **How:** Looks the paths up on Drive (`properties.path`), recreates missing
  folders oldest-first, then downloads each file into the vault with
  `createFile` (remote mtime).
- **Success:** all folders/files restored locally.
- **Failure:** a failed content fetch shows a notice; the loop continues (the
  `batchAsyncs` results are not individually re-thrown).

**`handleCreate(paths)`**
- **Purpose:** Undo a local creation.
- **How:** Deletes each local path via `t.deleteFile` (trash).
- **Success:** all queued creations removed locally.
- **Failure:** relies on `deleteFile`'s boolean; missing files are ignored.

**`handleModify(paths)`**
- **Purpose:** Undo local edits by restoring the Drive version.
- **How:** For each file, fetches content + metadata in parallel and
  `modifyFile`s it with the remote mtime.
- **Success:** every file reverted.
- **Failure:** a failed fetch shows a notice and skips that file.

**`handleRename(paths)`**
- **Purpose:** Undo local renames.
- **How:** Processes shallowest-first so renaming a folder carries its
  descendants; descendants of an already-renamed folder just drop their
  `renames` entry. Each rename runs through `runInternalOperation`.
- **Success:** paths (and folder trees) restored to their Drive names.
- **Failure:** a failed rename logs a warning, keeps its `renames` entry and
  continues with the others.

---

### `push(t, options?)`

**Purpose:** Reconcile local pending changes to Drive; after checking the latest
Drive state, upload the files and folders whose local date modified is newer
(section 2.1).

**How (ordered):**
1. Bail out if `syncing`. Snapshot the pending operations (alphabetical).
2. If configured and not skipped, show `ConfirmPushModal`.
3. `startSync()` (on error: notice unless silent, return).
4. `pull(t, true)` — *check* the latest Drive state first (a silent pull that
   does not end the session); *throws* if it returns `false`, aborting the push.
5. Snapshot `operations` and `renames`; classify into
   `deletes`/`renames`/`creates`/`modifies`; build `pathsToIds`.
6. Reconcile config-file ids from Drive (`properties.config="true"`) and queue
   deletions for config files missing locally.
7. **Fetch latest dates:** `searchFiles` (chunked, 50 paths per query) for every
   pending `create`/`modify`/`delete` path, recording each path's `id`,
   `modifiedTime` and `mimeType` in `remoteMeta`. The returned ids also repair
   `driveIdToPath`/`pathsToIds`, so a stale mapping can no longer make a delete a
   no-op or an upload a duplicate. A failed lookup throws
   `"An error occurred fetching Google Drive files."` (no silent success).
8. **Deletes:** `batchDelete` the ids; per-id results decide success; successful
   ids are removed from `driveIdToPath`.
9. **Renames:** update metadata (name, `properties.path`, parents) for renamed
   folders (then their descendants) and files, shallowest-first for folders.
10. **Creates:** a folder already confirmed on Drive in `remoteMeta` is skipped
    (no duplicate); for a file with an existing Drive id, the object is
    **updated** only when the local `stat.mtime` is strictly newer, otherwise it
    is skipped via `staleSkipped`; a genuinely new file is uploaded
    (`uploadFile`).
11. **Modifies:** if Drive's `modifiedTime` is newer than or equal to the local
    `stat.mtime`, the upload is skipped via `staleSkipped` instead of clobbering
    Drive; otherwise `updateFile` for known ids, falling back to `uploadFile`
    when the remote file is gone or has no id; batches of 10.
12. **Config:** write `data.json` locally, then create missing config folders and
    upload/update config files; the settings file is uploaded last with
    `getSettingsForSync()`.
13. **Cleanup:** delete only the snapshot operations/renames that succeeded (and
    whose value is unchanged), leaving edits made during the push queued;
    `saveSettings`.
14. `endSync(syncNotice, false, failedOperations.size === 0)` — the watermark is
    advanced **only** when nothing failed. Skipped-but-newer items are logged
    (not treated as failures).

**Inner helper `hasFailedConfigParent(path)`** — walks a path's ancestors and
returns `true` if any is in `failedOperations`, so a config file is skipped when
the folder it belongs to failed.

**Success:** every operation applied (or correctly skipped because Drive was
newer/equal), watermark advanced, `"Sync complete!"` shown.
**Failure:** per-item failures are collected in `failedOperations`; those
operations/renames stay queued for the next run, the watermark is **not**
advanced (`markSynced = false`), and config failures throw
`"One or more Obsidian configuration files failed to sync."`. When one or more
items failed, the user sees
`"Sync incomplete: N item(s) could not be pushed and will be retried."` —
`"Sync complete!"` is shown **only** when nothing failed. Any thrown error is
logged and (unless silent) shown as `"Sync failed: …"`. `finally` always clears
`pendingChangesToken`, `syncing` and the spinner.

---

## 3.8 `helpers/reset.ts` — destructive mirror of Drive

### `ConfirmResetModal`

**`constructor(t, proceed)`** — warning modal ("You'll lose all local changes…
irreversible") with Cancel and a warning-styled `RESET!` button.
**Success:** `proceed(true)`. **Failure:** Cancel/close → `proceed(false)`.

**`onClose()`** — resolves `false` unless `RESET!` was pressed.

### `reset(t)`

**Purpose:** Throw away local divergence and make the vault an exact copy of
Drive (used to recover from a broken state).

**How (ordered):**
1. Bail if `syncing`; show `ConfirmResetModal`.
2. `startSync()`; then `pull(t, true)` — throws if it returns `false`.
3. Classify pending operations into `deletes`/`creates`/`modifies`.
4. For queued **creates**, delete those local files (`deleteFilesMinimumOperations`)
   and require every result to be `true`.
5. For **modifies**, fetch content+metadata from Drive and `modifyFile` locally.
6. For **deletes**, search Drive by `properties.path`; **throw if any path cannot
   be found**; recreate missing folders oldest-first; recreate files
   (`createFile`).
7. `endSync`, clear `operations` and `renames`, save, `Notice("Reset complete.")`.

**Success:** local vault mirrors Drive exactly and the pending queue is empty.
**Failure:** any Drive/IO error (including a Drive record that cannot be located)
throws, is logged, and is shown as `"Reset failed: …"`; the queue is left intact
so nothing is silently forgotten. `finally` always clears `pendingChangesToken`,
`syncing` and the spinner.

---

## 3.9 `helpers/ky.ts` — HTTP client & OAuth hooks

**`getHooks(t): Hooks`**
- **Purpose:** Attach the bearer token and transparently recover from expiry.
- **`beforeRequest`:** if the access token is missing or expires within 60s,
  `await t.refreshAccessToken()` (mutex-protected); then sets
  `Authorization: Bearer <token>` when a token exists.
- **`afterResponse`:** on `401` (and a stored refresh token) refresh once and
  replay the request via `ky(request, { timeout: 120_000 })`; otherwise, for any
  non-OK response, logs status + body (cloned) and returns the response so `ky`
  still throws its `HTTPError`. The retry keeps the same generous timeout rather
  than ky's 10s default.
- **Success:** authenticated requests; one silent recovery from an expired token.
- **Failure:** if the refresh fails the original response/`HTTPError` is returned
  (wrapped into `undefined` by the Drive client). `ky` clones the request for
  retries, so replaying non-GET bodies (uploads) is safe.

**`getDriveKy(t)`**
- **Purpose:** The configured client used by every Drive call.
- **How:** `ky.extend({ prefixUrl: "https://www.googleapis.com", hooks:
  getHooks(t), timeout: 120_000 })`.
- **Success:** long-timeout, auto-authenticated requests.
- **Failure:** none; errors surface as `HTTPError`/`TimeoutError`.

---

## 3.10 `helpers/deviceAuth.ts` — OAuth Device Flow primitives

Scope is `https://www.googleapis.com/auth/drive.file` (the only broad scope
supported by the device flow; it covers files the app creates).

**`requestDeviceCode(credentials): Promise<DeviceCodeResponse>`**
- **Purpose:** Step 1 — obtain a device + user code.
- **How:** `POST https://oauth2.googleapis.com/device/code` with `client_id` and
  `scope`; returns `device_code`, `user_code`, `verification_url`,
  optional `verification_uri`, `expires_in`, `interval`.
- **Success:** the parsed device-code response.
- **Failure:** throws `"Failed to request device code: <status>"` (network,
  invalid client). The modal turns this into a friendly message.

**`pollForToken(deviceCode, intervalSeconds, expiresInSeconds, credentials,
onPending?)`**
- **Purpose:** Step 2 — poll until the user approves.
- **How:** Sleeps `interval` seconds, `POST`s to `/token` with the device grant,
  and interprets Google's error codes: `authorization_pending` → keep waiting
  (calling `onPending`, which returns `false` to cancel); `slow_down` → add 5s to
  the interval (also respecting `onPending`); anything else is terminal. Stops at
  the deadline.
- **Success:** the `TokenResponse` (`access_token`, `refresh_token`,
  `expires_in`, scope, type).
- **Failure:** rejects with `"cancelled"`, `"access_denied"`,
  `"expired_token"` or the raw OAuth error; the modal maps these to messages.

**`refreshAccessTokenWithRefreshToken(refreshToken, credentials)`**
- **Purpose:** Exchange a refresh token for a new access token.
- **How:** `POST https://oauth2.googleapis.com/token` with the refresh grant.
- **Success:** `{access_token, expires_in}` (used by
  `ObsidianGoogleDrive.refreshAccessToken`).
- **Failure:** throws `"Failed to refresh access token: <status>"`; the caller
  logs it, shows a notice and returns `false`.

**`sleep(ms)`** — `setTimeout` promise helper. **Success:** resolves after the
delay. **Failure:** none.

---

## 3.11 `deviceAuthModal.ts` — connect UI

**`constructor(app, credentials, onSuccess)`** — stores the credentials and an
async success callback.

**`onOpen()`**
- **Purpose:** Run the device flow inside a modal.
- **How:** Requests a device code (showing "Requesting a login code from
  Google…"), displays the user code in large selectable text, offers an
  `Open <url>` button (using `verification_url` or `verification_uri`), then
  polls. On success it `await`s `onSuccess(tokens)`, shows "Connected!" and
  closes. Errors are mapped (`access_denied`, `expired_token`, other) and a
  notice is shown.
- **Success:** tokens handed to the plugin, which stores the refresh token and
  runs the initial sync.
- **Failure:** network error → "Failed to reach Google…"; denial/expiry →
  specific status text; cancellation (modal closed) → silent return.

**`onClose()`** — sets `cancelled = true` (stopping the poll loop) and clears the
content element.

---

## 3.12 `helpers/googleOAuthConfig*.ts` — legacy credentials

**`googleOAuthConfig.example.ts`** — empty `GOOGLE_CLIENT_ID` /
`GOOGLE_CLIENT_SECRET` placeholders and a note that credentials are now entered
in plugin settings.

**`googleOAuthConfig.ts`** — an earlier developer configuration file. It is **not
imported by any runtime code** (`deviceAuth.ts` takes credentials as parameters
from settings) but is tracked in git and contains a real client id/secret. Treat
it as dead code that must be removed from version control and rotated (see §5).

---

## 4. End-to-end success & failure cases

| Scenario | Expected result |
|----------|-----------------|
| Obsidian starts with newer files on Drive | Automatic startup pull downloads files/folders whose `modifiedTime > lastSyncedAt`, then advances the watermark (see 2.2) |
| Edit a note, `syncOnSave` on | Debounced silent `runSync`; push uploads the `modify`; success notice suppressed (silent) |
| Create a folder + note, then sync | Folder created first (depth batching), then the file uploaded under it; ids recorded in `driveIdToPath` |
| Rename a note that already exists on Drive | Only `properties.path`/`name` patched — no re-upload; backlinks/history preserved |
| Rename a folder | Folder + all descendant `properties.path` re-prefixed; local `operations`/`renames` re-prefixed |
| Delete a note, then sync | Local delete queued; push removes the Drive object; id removed from `driveIdToPath` |
| Delete on Drive (other device), then pull | `getChanges` reports it; local file is trashed; if it had a pending local edit it is preserved and re-uploaded instead |
| Remote file modified on another device | `modifiedTime > lastSyncedAt` → compared with the local `stat.mtime`: the newer copy wins (a newer Drive version is downloaded; a newer local edit is pushed later) |
| Local file older than its Drive copy, then sync | `modifiedTime >= stat.mtime` in `remoteMeta` → upload skipped (`staleSkipped`), Drive version kept; not counted as a failure |
| Local file whose path already exists on Drive, then sync | The existing Drive object is updated in place only when the local file is newer — never duplicated |
| Offline | `startSync` throws the friendly "not connected…" message; no state changes |
| Access token expired | `beforeRequest` refreshes; if it expires mid-request, the 401 hook refreshes and replays once |
| Refresh token revoked | Refresh returns `false`; requests 401, are not retried again, resolve `undefined`, and the sync reports a Drive error |
| Remote rename target already exists locally | That file is skipped, other changes still apply, a warning notice appears, watermark not advanced → retried next sync |
| Push partially fails (bad file, quota…) | Failed operations stay queued; watermark not advanced; (non-silent) "Sync incomplete: N item(s) could not be pushed and will be retried." |
| Config file fails to sync | `configSyncFailed` → push throws "One or more Obsidian configuration files failed to sync." |
| Reset with a missing Drive record | `reset` throws "Unable to locate N file(s)…" and reports "Reset failed: …"; queue untouched |
| Upgrade from a pre-`vaultId` version | `ensureVaultMigrated` stamps `vaultId` on the existing tree → same ids, same tree, no duplication |
| User edits while a sync is running | Edit is recorded (not suppressed) and picked up by the next (possibly re-armed) sync |
| Disconnect account | Local queue/id map cleared; Drive tree untouched; reconnect rediscovers it via `vaultId` |

---

## 5. Changes made in this revision

Fixes applied to `main.ts`, `helpers/*.ts` and `deviceAuthModal.ts` (the
committed credential file was intentionally left untouched, per instruction).
Verified with `tsc --noEmit`, `eslint` (clean) and `npm run build`.

### 5.1 User edits during a sync were silently dropped — fixed
- Added `internalOperationCount`, `isApplyingRemoteChange()` and
  `runInternalOperation()` to `main.ts`.
- The four vault handlers (`handleCreate/Delete/Modify/Rename`) now guard on
  `isApplyingRemoteChange()` instead of `syncing`, so genuine user edits made
  while a sync runs are queued and pushed later.
- Every plugin-initiated vault mutation is wrapped in `runInternalOperation`
  (`createFolder`, `createFile`, `modifyFile`, `upsertFile`, `deleteFile`, and
  the two `fileManager.renameFile` call sites), so their events are still ignored.
- `pull`'s `restorePullState()` now merges operations recorded during the pull
  instead of discarding them on rollback.

### 5.2 Push discarded operations recorded mid-sync — fixed
- `push.ts` no longer rebuilds `operations`/`renames` from only the failed set.
  It deletes just the snapshot entries it processed successfully (and whose value
  is unchanged), preserving concurrent user edits for the next sync.

### 5.3 Failed syncs advanced the watermark (remote changes missed) — fixed
- `endSync` gained a `markSynced` parameter. `push` passes
  `failedOperations.size === 0`, so `lastSyncedAt` only advances after a fully
  successful run; `pull` passes `failedRemoteRenames.size === 0`.

### 5.4 Changes feed lost data on transient errors — fixed
- `drive.ts` `getChanges` only renews the start token for HTTP `400/404/410`;
  every other error is rethrown so the sync fails loudly instead of silently
  skipping unseen changes.

### 5.5 Upgrade would duplicate the Drive tree — fixed
- Added `vaultIdMigrated` to the settings model and `ensureVaultMigrated()` +
  `listFilesByRawQuery()` in `drive.ts`. `pull` calls it before searching, so a
  pre-`vaultId` tree is adopted (ids preserved) rather than duplicated.

### 5.6 `updateFile` omitted `properties.vaultId` — fixed
- `updateFile` now writes `vaultId`, matching `createFolder`, `uploadFile` and
  `updateFileMetadata`.

### 5.7 Remote folder renames left descendants stale — fixed
- `pull.ts` gained `renamePrefixes()` to move descendant
  `driveIdToPath`/`operations`/`renames` when a Drive folder is renamed.

### 5.8 Pending local renames could be clobbered into duplicates — fixed
- `pull.ts` `upsertFiles` skips a remote file whose path is the original path of
  a pending local rename, so the old path is not resurrected.

### 5.9 One un-renamable file blocked the whole sync — fixed
- `pull.ts` no longer returns `false` immediately on failed remote renames; it
  finishes the rest, warns (non-silent) and returns `true`, while leaving the
  watermark unchanged so the rename retries. The silent success path now returns
  `true` instead of `undefined`.

### 5.10 Reset reported success while dropping items — fixed
- `reset.ts` throws when a queued delete cannot be found on Drive (and when the
  Drive lookup fails), instead of continuing to "Reset complete."

### 5.11 Undo modal only affected one file — fixed
- `push.ts` `handleCreate/handleModify/handleRename` take `string[]`; rename
  processes shallowest-first and skips descendants of already-renamed folders,
  running each rename as an internal operation.

### 5.12 Misc hardening
- `main.ts` `loadSettings` copies `operations`/`renames`/`driveIdToPath` so a
  partial `data.json` can no longer alias/mutate `DEFAULT_SETTINGS`.
- `getSettingsForSync` now strips `refreshToken` (never uploaded) and
  `mergeSyncedSettings` preserves the local one; each device keeps its own token.
- `push.ts`: silent syncs no longer show Notices for folder/file create failures;
  removed the unused `pluginId`.
- `ky.ts`: removed the unused `Notice` import; the 401 retry keeps the 120s
  timeout instead of ky's 10s default.
- `deviceAuth.ts`/`deviceAuthModal.ts`: `slow_down` honours cancellation and the
  UI accepts `verification_uri` as a fallback for `verification_url`.
- `pull.ts`: replaced `(vault as any).getConfig(...)` with a typed accessor.

### 5.13 Known remaining item (not changed)
- `helpers/googleOAuthConfig.ts` is tracked in git, unused at runtime, and
  contains a real OAuth client id/secret. It should be removed from the
  repository (`git rm --cached`), purged from history and the secret rotated in
  Google Cloud Console.

### 5.14 Push is now date-gated and never reports a false success
- **Latest dates first:** `push.ts` fetches the current Drive `modifiedTime` for
  every pending `create`/`modify`/`delete` path (chunked `searchFiles`, 50 paths
  per query) into `remoteMeta`, and uses the returned ids to repair
  `driveIdToPath`/`pathsToIds` so deletes are not no-ops and uploads do not
  duplicate.
- **Push newer files/folders only:** a `modify` is uploaded only when the local
  `stat.mtime` is strictly newer than Drive's `modifiedTime`; a `create` whose
  path already exists on Drive updates that object in place (only when newer)
  instead of duplicating it; a folder already on Drive is not re-created. Skipped
  items are recorded in `staleSkipped` and logged — they are not failures.
- **Newest wins on pull too:** `pull.ts` `upsertFiles` no longer lets any pending
  local `modify` block a download. It compares the local `stat.mtime` with the
  remote `modifiedTime`: a newer local edit is kept for the push, while a newer
  Drive copy is downloaded and the stale local edit dropped (the local edit is
  kept when the two cannot be compared).
- **No false successes:** `"Sync complete!"` is shown only when
  `failedOperations` is empty; otherwise the user sees `"Sync incomplete: N
  item(s) could not be pushed and will be retried."` The failed paths stay
  queued, the watermark is not advanced, and a failed Drive metadata lookup
  throws instead of silently continuing. The config-file and delete-error
  notices are now suppressed in silent mode like the others.

### 5.15 Mobile (Android / iOS) hardening
- Added `helpers/util.ts` with a `randomUUID()` fallback (so `loadSettings()`
  can no longer throw on WebViews that lack `crypto.randomUUID`) and a
  `toMilliseconds()` mtime normaliser.
- `deviceAuthModal.ts`: mobile-aware `window.open`, selectable URL text and a
  Notice fallback when the browser does not open.
- `pull.ts`: falls back to the local `.trash` on mobile; mtime comparison
  normalised.
- `push.ts`: mtime comparisons normalised.
- `main.ts`: the ribbon context menu is also opened by a touch long-press via
  `Menu.showAtPosition`; DOM listeners now use `registerDomEvent`.
See section 6 for details.

---

### 5.16 Sync robustness fixes (retry, deletion, rename and config edge cases)
- **Uploads are retried.** `helpers/ky.ts` now retries POST/PATCH as well as
  GET, and treats 403 (Drive's rate-limit status) and 429/5xx as retryable
  with exponential backoff. Previously a single rate-limited upload failed the
  sync outright.
- **A failed PATCH no longer duplicates the file.** `push.ts` uses
  `drive.tryUpdateFile`, which keeps the HTTP status, and only re-uploads a
  "new" copy after a 404. A transient error leaves the operation queued.
- **Preserved edits survive folder deletions.** When a folder is deleted on
  Drive but a note inside it has an unsynced local edit, the folder is kept
  (it used to be trashed with the edit inside) and queued as a `create` so the
  next push recreates it; a retained folder used to have no Drive id, which
  made every upload into it fail forever.
- **Delete-then-rename onto the same path.** `handleRename` keeps the pending
  delete by Drive id (`settings.pendingDeleteIds`, flushed by push) instead of
  letting the rename overwrite it, so Drive no longer ends up with two files
  at one path.
- **Folder renames fire one event per descendant.** `handleRename` now
  recognises a child event whose entry the folder's own event already moved,
  instead of downgrading a pending `modify`/`create` to a bare `rename`.
- **A pending local rename is not undone by a remote edit.** `pull.ts` no
  longer renames the local file back to the stale remote path; the remote
  content is applied to the renamed local file and the push then moves the
  Drive object. Remote renames are applied shallowest-first.
- **Config edits survive a pull.** `endSync` stamped changed config files
  *before* moving the watermark, so a hotkey/theme/plugin-setting change made
  before a startup or manual pull was never pushed. The stamp is now placed
  just past the new watermark and excludes the files the pull itself wrote
  (`pulledConfigPaths`).
- **A save during an upload is not lost.** Push records each file's mtime at
  read time and keeps the operation when the file changed meanwhile.
- **Single sync lock.** `startSync`/`claimSyncLock` claim `syncing` before any
  `await`, so the sync-on-save timer and a ribbon click can no longer run two
  pushes at once.
- **Auth failure back-off.** A failed token refresh pauses sync-on-save and
  throttles the notice to once a minute; the refresh error now includes
  Google's error code (e.g. `invalid_grant`).
- **Efficiency.** The root folder id is cached per sync (it was one Drive
  search per root-level file); descendant `properties.path` updates on a
  folder rename are batched; this plugin's `data.json` is uploaded once per
  push instead of twice, after the queue is cleaned, and without the
  device-local queues; modified binaries keep a correct mimeType.

## 6. Mobile (Android / iOS) compatibility

`manifest.json` declares `isDesktopOnly: false`, so the plugin runs inside
Obsidian's Capacitor WebView, which can be older than a desktop browser and has a
different filesystem. The plugin uses no Node/Electron APIs, and the following
guards cover the WebView-specific gaps.

### 6.1 Handled
- **UUID generation no longer aborts plugin load.** `loadSettings()` used
  `crypto.randomUUID()`, which requires a secure context and only exists on iOS
  Safari 15.4+ / Chrome 92+. On older devices it is `undefined`, which threw
  during `onload()` and stopped the entire plugin from loading. It now uses
  `randomUUID()` from `helpers/util.ts`, which falls back to
  `crypto.getRandomValues()` and finally `Math.random`.
- **OAuth device flow can open the browser on mobile.** `deviceAuthModal.ts`
  used `window.open(url, "_blank")`, which the mobile WebView ignores; it now
  calls `window.open(url)` when `Platform.isMobileApp`, shows the URL as
  selectable text, and shows a Notice with the link if nothing opened.
- **Config deletions fall back to local trash.** `pull.ts` used
  `adapter.trashSystem` for the user's "system trash" setting; mobile has no
  system trash, so it now uses `trashLocal` on mobile (and whenever
  `trashSystem` is unavailable), bound to the adapter.
- **mtime normalisation.** `helpers/util.ts` `toMilliseconds()` converts
  second-precision file times to milliseconds so the newest-wins comparisons in
  `pull.ts`/`push.ts` are not mis-ordered if a mobile adapter reports seconds.
- **Ribbon menu reachable by touch.** The context menu is now also opened by a
  500 ms long-press (`touchstart`/`touchend` on the ribbon icon) using
  `Menu.showAtPosition`, and the trailing click is suppressed so it does not
  fire a second action. The `contextmenu` listener is registered via
  `registerDomEvent` so it is cleaned up on unload.

### 6.2 Known platform limitations (not fixable plugin-side)
- **Large binary pulls on Android can hang.** Obsidian's mobile
  `CapacitorAdapter.writeBinary` is reported to never resolve and to keep
  appending data for large blobs (tens of MB). Because the pull writes files
  with `adapter.writeBinary`, very large files can stall a pull on Android.
  Chunked downloads or a size guard would be the follow-up.
- **`mtime` fidelity.** If a mobile adapter ignores the `mtime` written with a
  pulled file, the local timestamp becomes "now"; normalisation keeps the
  comparison sane, but device-clock skew can still make a just-pulled file look
  newer than Drive and cause a redundant re-upload.
- **Device-flow UX.** The user must leave Obsidian to approve the code in a
  browser; if the OS suspends the WebView the poll loop pauses and the code can
  expire before approval.
