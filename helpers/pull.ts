import ObsidianGoogleDrive from "main";
import { Notice, Platform, TAbstractFile, TFile, TFolder } from "obsidian";
import {
	batchAsyncs,
	FileMetadata,
	folderMimeType,
	foldersToBatches,
	getSyncMessage,
} from "./drive";
import { toMilliseconds } from "./util";

export const pull = async (
	t: ObsidianGoogleDrive,
	silenceNotices?: boolean,
) => {
	let syncNotice: Notice | undefined;

	if (!silenceNotices) {
		if (t.syncing) return;
		try {
			syncNotice = await t.startSync();
		} catch (error) {
			new Notice(error instanceof Error ? error.message : String(error));
			return;
		}
	}

	try {
		const { vault } = t.app;
		const adapter = vault.adapter;
		const originalDriveIdToPath = { ...t.settings.driveIdToPath };
		const originalOperations = { ...t.settings.operations };
		const restorePullState = () => {
			t.settings.driveIdToPath = originalDriveIdToPath;
			// Preserve operations recorded by user edits while the pull was
			// running. Only the keys the pull itself touched are rolled back.
			for (const [path, operation] of Object.entries(
				t.settings.operations,
			)) {
				if (!(path in originalOperations)) {
					originalOperations[path] = operation;
				}
			}
			t.settings.operations = originalOperations;
			t.pendingChangesToken = undefined;
		};

		// Config files written by this pull are remembered so endSync does not
		// mistake them for local edits (see endSync).
		t.pulledConfigPaths.clear();

		if (!t.accessToken.token) await t.refreshAccessToken();

		// Make sure a tree created before vaultId scoping is adopted instead
		// of being duplicated.
		if (!(await t.drive.ensureVaultMigrated())) {
			new Notice(
				"An error occurred preparing Google Drive for this vault.",
			);
			restorePullState();
			return false;
		}

		const recentlyModified = await t.drive.searchFiles({
			include: ["id", "modifiedTime", "properties", "mimeType"],
			matches: [
				{
					modifiedTime: {
						gt: new Date(t.settings.lastSyncedAt).toISOString(),
					},
				},
			],
		});
		if (!recentlyModified) {
			new Notice("An error occurred fetching Google Drive files.");
			restorePullState();
			return false;
		}

		const changesData = await t.drive.getChanges(t.settings.changesToken);
		if (!changesData) {
			new Notice("An error occurred fetching Google Drive changes.");
			restorePullState();
			return false;
		}

		if (changesData.newStartPageToken) {
			t.pendingChangesToken = changesData.newStartPageToken;
		}

		const deletedIds = new Set<string>();

		// 1. Collect deleted or trashed items from Drive changes log
		for (const change of changesData.changes) {
			if (change.removed || change.file?.trashed) {
				deletedIds.add(change.fileId);
			}
		}

		// 2. If changes token was renewed, perform full reconciliation against active Drive files
		if (changesData.tokenRenewed) {
			const onlineFiles = await t.drive.searchFiles({});
			if (!onlineFiles) {
				restorePullState();
				return false;
			}
			const onlineIds = new Set(onlineFiles.map((f) => f.id));
			for (const id of Object.keys(t.settings.driveIdToPath)) {
				if (!onlineIds.has(id)) {
					deletedIds.add(id);
				}
			}
		}

		const deletions: TAbstractFile[] = [];
		for (const fileId of deletedIds) {
			const path = t.settings.driveIdToPath[fileId];
			if (!path) continue;
			const file = vault.getAbstractFileByPath(path);

			if (!file && t.settings.operations[path] === "delete") {
				delete t.settings.operations[path];
				continue;
			}
			if (file) {
				deletions.push(file);
			}
		}

		if (!recentlyModified.length && !deletions.length) {
			if (silenceNotices) return true;
			await t.endSync(syncNotice);
			return new Notice("You're up to date!");
		}

		const pathToId = Object.fromEntries(
			Object.entries(t.settings.driveIdToPath).map(([id, path]) => [
				path,
				id,
			]),
		);

		// A local rename that has not been pushed yet wins over the stale
		// remote path: the push will move the Drive object. A folder rename
		// only records the folder itself in `renames`, so check every ancestor.
		const hasPendingLocalRename = (localPath: string | undefined) => {
			if (!localPath) return false;
			const renames = t.settings.renames || {};
			const parts = localPath.split("/");
			for (let i = parts.length; i > 0; i--) {
				if (renames[parts.slice(0, i).join("/")]) return true;
			}
			return false;
		};

		// Apply shallowest paths first so a renamed folder exists locally
		// before the renames of the notes inside it are attempted.
		recentlyModified.sort(
			(a, b) =>
				(a.properties?.path?.split("/").length ?? 0) -
				(b.properties?.path?.split("/").length ?? 0),
		);

		// Handle remote renames: If a Drive ID is already mapped to an old path,
		// rename the local file in Obsidian to keep Obsidian's internal history and links intact.
		const failedRemoteRenames = new Set<string>();

		// When a Drive folder is renamed, every descendant's path changes with
		// it. Move the pending mappings/operations/renames along with it so a
		// file that was not itself modified does not keep pointing at the old
		// subtree.
		const renamePrefixes = (oldPath: string, newPath: string) => {
			const oldPrefix = oldPath + "/";
			const newPrefix = newPath + "/";

			for (const [id, path] of Object.entries(pathToId)) {
				if (path.startsWith(oldPrefix)) {
					pathToId[id] = newPrefix + path.slice(oldPrefix.length);
				}
			}
			for (const [opPath, op] of Object.entries(t.settings.operations)) {
				if (opPath.startsWith(oldPrefix)) {
					delete t.settings.operations[opPath];
					t.settings.operations[
						newPrefix + opPath.slice(oldPrefix.length)
					] = op;
				}
			}
			for (const [renamePath, original] of Object.entries(
				t.settings.renames || {},
			)) {
				if (renamePath.startsWith(oldPrefix)) {
					delete t.settings.renames[renamePath];
					t.settings.renames[
						newPrefix + renamePath.slice(oldPrefix.length)
					] = original;
				} else if (original.startsWith(oldPrefix)) {
					t.settings.renames[renamePath] =
						newPrefix + original.slice(oldPrefix.length);
				}
			}
		};

		for (const remoteFile of recentlyModified) {
			const newPath = remoteFile.properties?.path;
			if (!newPath) continue;

			const oldPath = t.settings.driveIdToPath[remoteFile.id];
			if (!oldPath || oldPath === newPath) continue;
			// `oldPath` is where this device moved the file; renaming it back
			// to the remote path would silently undo the user's own rename.
			if (hasPendingLocalRename(oldPath)) continue;

			const localAbstractFile = vault.getAbstractFileByPath(oldPath);
			if (localAbstractFile) {
				try {
					await t.runInternalOperation(() =>
						t.app.fileManager.renameFile(
							localAbstractFile,
							newPath,
						),
					);
				} catch (renameErr) {
					failedRemoteRenames.add(remoteFile.id);
					console.warn(
						"[Obsidian Gdrive Sync] Could not rename local file from Drive change:",
						oldPath,
						newPath,
						renameErr,
					);
				}
			}
			if (failedRemoteRenames.has(remoteFile.id)) continue;

			delete pathToId[oldPath];
			if (t.settings.operations[oldPath]) {
				t.settings.operations[newPath] =
					t.settings.operations[oldPath];
				delete t.settings.operations[oldPath];
			}
			if (remoteFile.mimeType === folderMimeType) {
				renamePrefixes(oldPath, newPath);
			}
		}
		const updateMap = () => {
			recentlyModified.forEach(({ id, properties }) => {
				if (failedRemoteRenames.has(id)) return;
				if (hasPendingLocalRename(t.settings.driveIdToPath[id])) return;
				if (properties?.path) {
					pathToId[properties.path] = id;
				}
			});

			t.settings.driveIdToPath = Object.fromEntries(
				Object.entries(pathToId).map(([path, id]) => [id, path]),
			);
		};

		updateMap();

		const deleteFiles = async () => {
			const preservedPaths = new Set<string>();
			const deletedFiles = deletions
				.filter((file) => file instanceof TFile)
				.filter((file: TFile) => {
					if (t.settings.operations[file.path] === "modify") {
						// This file's Drive counterpart was deleted, but there's
						// an unsynced local edit. Preserve it locally and mark
						// it to be re-uploaded on the next push, rather than
						// deleting it and losing the edit.
						t.settings.operations[file.path] = "create";
						preservedPaths.add(file.path);
						return false;
					}
					return true;
				}) as TFile[];

			// Paths that are really going away. Preserved files are excluded
			// so their parent folders survive as well; previously the folder
			// was trashed with the preserved edit still inside it.
			const deletionPaths = new Set(deletions.map((file) => file.path));
			preservedPaths.forEach((path) => deletionPaths.delete(path));

			const isFullyDeleted = (folder: TFolder): boolean =>
				folder.children.every(
					(child) =>
						deletionPaths.has(child.path) &&
						(!(child instanceof TFolder) || isFullyDeleted(child)),
				);

			const retainedFolders: TFolder[] = [];
			const deletedFolders = deletions
				.filter((folder) => folder instanceof TFolder)
				.filter((folder: TFolder) => {
					if (isFullyDeleted(folder)) return true;
					retainedFolders.push(folder);
					return false;
				}) as TFolder[];

			// A retained folder no longer exists on Drive and its id is dropped
			// at the end of the pull. Queue it as a create so the next push
			// recreates it; otherwise every note left inside it would fail to
			// upload forever because its parent has no Drive id.
			for (const folder of retainedFolders) {
				t.settings.operations[folder.path] = "create";
				if (t.settings.renames) delete t.settings.renames[folder.path];
			}

			const results = await t.drive.deleteFilesMinimumOperations([
				...deletedFolders,
				...deletedFiles,
			]);
			return Boolean(
				results && Object.values(results).every((result) => result),
			);
		};

		if (!(await deleteFiles())) {
			t.pendingChangesToken = undefined;
			return false;
		}

		syncNotice?.setMessage("Syncing (33%)");

		const upsertFiles = async () => {
			const newFolders = recentlyModified.filter(
				({ id, mimeType, properties }) =>
					!failedRemoteRenames.has(id) &&
					!hasPendingLocalRename(t.settings.driveIdToPath[id]) &&
					mimeType === folderMimeType &&
					Boolean(properties?.path),
			);

			if (newFolders.length) {
				const batches = foldersToBatches(
					newFolders.map(({ properties }) => properties.path),
				);

				for (const batch of batches) {
					const folderResults = await Promise.all(
						batch.map(async (folder) => {
							if (
								vault.getFolderByPath(folder) ||
								(await adapter.exists(folder))
							) {
								delete t.settings.operations[folder];
								return;
							}
							try {
								await t.createFolder(folder);
							} catch (error) {
								console.warn(
									"[Obsidian Gdrive Sync] Could not create local folder:",
									folder,
									error,
								);
								return false;
							}
							delete t.settings.operations[folder];
							return true;
						}),
					);
					if (folderResults.some((result) => result === false)) {
						return false;
					}
				}
			}

			let completed = 0;

			const newNotes = recentlyModified.filter(
				({ id, mimeType, properties }) =>
					!failedRemoteRenames.has(id) &&
					mimeType !== folderMimeType &&
					Boolean(properties?.path),
			);

			const results = await batchAsyncs(
				newNotes.map((file: FileMetadata) => async () => {
					// A local rename that has not been pushed yet means the
					// remote path is stale. Apply the Drive content to the
					// renamed local file instead of resurrecting the old path
					// next to it (and instead of dropping the remote edit).
					const mappedPath = t.settings.driveIdToPath[file.id];
					const localPath =
						mappedPath && hasPendingLocalRename(mappedPath)
							? mappedPath
							: file.properties.path;

					const localFile =
						vault.getFileByPath(localPath) ||
						(await adapter.exists(localPath));
					const operation = t.settings.operations[localPath];

					completed++;

					if (localFile && operation === "modify") {
						// Newest write wins: keep the pending local edit only
						// when it is strictly newer than the Drive copy.
						// Otherwise the local edit is stale, so drop it and
						// fall through to apply the Drive version.
						const localMtime = toMilliseconds(
							localFile instanceof TFile
								? localFile.stat.mtime
								: (await adapter.stat(localPath))?.mtime,
						);
						const remoteMtime = Date.parse(file.modifiedTime);
						if (
							localMtime === undefined ||
							Number.isNaN(remoteMtime) ||
							localMtime > remoteMtime
						) {
							return;
						}
						delete t.settings.operations[localPath];
					}

					if (localFile && operation === "create") {
						t.settings.operations[localPath] = "modify";
						return;
					}

					let content = await t.drive.getFileContent(file.id);

					if (!content) {
						new Notice(
							`Could not download ${file.properties.path} from Google Drive.`,
						);
						return false;
					}

					if (file.properties.path === t.getSettingsFilePath()) {
						content = t.mergeSyncedSettings(content);
					}

					syncNotice?.setMessage(
						getSyncMessage(33, 100, completed, newNotes.length),
					);

					if (localFile instanceof TFile) {
						await t.modifyFile(localFile, content, file.modifiedTime);
					} else {
						await t.upsertFile(localPath, content, file.modifiedTime);
					}
					// Config files are tracked by mtime alone; remember which
					// ones this pull wrote so endSync does not re-flag them
					// as local edits.
					if (localPath.startsWith(vault.configDir + "/")) {
						t.pulledConfigPaths.add(localPath);
					}
					return true;
				}),
			);
			if (results.some((result) => result === false)) return false;
		};

		if ((await upsertFiles()) === false) {
			t.pendingChangesToken = undefined;
			return false;
		}

		const deleteConfigs = async () => {
			try {
				const configDeletions = await Promise.all(
					Array.from(deletedIds).map(async (fileId) => {
						const path = t.settings.driveIdToPath[fileId];
						if (!path || vault.getAbstractFileByPath(path)) return;
						const stat = await adapter.stat(path);
						if (!stat) return;
						return { path, type: stat.type };
					}),
				);

				let configDeletionsFiltered = configDeletions.filter(
					Boolean,
				) as {
					path: string;
					type: "file" | "folder";
				}[];

				let trashMethod = "system"; // Default fallback
				try {
					const trashOption = (
						vault as unknown as {
							getConfig?: (key: string) => unknown;
						}
					).getConfig?.("trashOption");
					if (typeof trashOption === "string") {
						trashMethod = trashOption;
					}
				} catch (error) {
					console.warn(
						"Could not read Obsidian trash option, defaulting to system trash.",
						error,
					);
				}
				if (trashMethod === "local" || trashMethod === "system") {
					// Mobile has no system trash, so prefer the local `.trash`
					// folder there (and whenever the method is unavailable).
					const useSystemTrash =
						trashMethod === "system" &&
						!Platform.isMobile &&
						typeof adapter.trashSystem === "function";
					const deletionMethod = (
						useSystemTrash ? adapter.trashSystem : adapter.trashLocal
					).bind(adapter);

					const folders = configDeletionsFiltered.filter(
						(file) => file.type === "folder",
					);

					if (folders.length) {
						const maxDepth = Math.max(
							...folders.map(
								({ path }) => path.split("/").length,
							),
						);

						for (let depth = 1; depth <= maxDepth; depth++) {
							const foldersToDelete =
								configDeletionsFiltered.filter(
									(file) =>
										file.type === "folder" &&
										file.path.split("/").length === depth,
								);
							await Promise.all(
								foldersToDelete.map(({ path }) =>
									deletionMethod(path),
								),
							);
							foldersToDelete.forEach(
								(folder) =>
									(configDeletionsFiltered =
										configDeletionsFiltered.filter(
											({ path }) =>
												!path.startsWith(
													folder.path + "/",
												) && path !== folder.path,
										)),
							);
						}
					}

					await Promise.all(
						configDeletionsFiltered.map(({ path }) =>
							deletionMethod(path),
						),
					);
					return true;
				}

				const deletedFiles = configDeletionsFiltered.filter(
					(file) => file.type === "file",
				);
				await Promise.all(
					deletedFiles.map(({ path }) => adapter.remove(path)),
				);

				const deletedFolders = configDeletionsFiltered.filter(
					(file) => file.type === "folder",
				);
				const batches = foldersToBatches(
					deletedFolders.map(({ path }) => path),
				);
				batches.reverse();

				for (const batch of batches) {
					await Promise.all(
						batch.map(async (folder) => {
							const list = await adapter.list(folder);
							if (list.files.length + list.folders.length) return;
							await adapter.rmdir(folder, false);
						}),
					);
				}
				return true;
			} catch (error) {
				console.warn(
					"[Obsidian Gdrive Sync] Could not delete local config files:",
					error,
				);
				return false;
			}
		};

		if (!(await deleteConfigs())) {
			t.pendingChangesToken = undefined;
			return false;
		}

		for (const fileId of deletedIds) {
			delete t.settings.driveIdToPath[fileId];
		}

		if (failedRemoteRenames.size) {
			// Do not let one un-renamable file block everything else. The
			// watermark is left untouched below so the rename is retried on the
			// next pull, and the user is told rather than getting a false
			// "everything synced" success.
			console.warn(
				"[Obsidian Gdrive Sync] Local renames that could not be applied:",
				Array.from(failedRemoteRenames),
			);
			if (!silenceNotices) {
				new Notice(
					`${failedRemoteRenames.size} item(s) could not be renamed locally and will be retried on the next sync.`,
				);
			}
		}

		if (silenceNotices) return true;

		await t.endSync(syncNotice, true, failedRemoteRenames.size === 0);

		new Notice("Files have been synced from Google Drive!");
		return true;
	} finally {
		if (!silenceNotices && t.syncing) {
			t.syncing = false;
			t.ribbonIcon?.removeClass("spin");
			syncNotice?.hide();
		}
	}
};
