import ObsidianGoogleDrive from "main";
import { Modal, Notice, setIcon, Setting, TFile, TFolder } from "obsidian";
import {
	batchAsyncs,
	fileNameFromPath,
	folderMimeType,
	foldersToBatches,
	getSyncMessage,
} from "./drive";
import { pull } from "./pull";
import { toMilliseconds } from "./util";

class ConfirmPushModal extends Modal {
	proceed: (res: boolean) => void;

	constructor(
		t: ObsidianGoogleDrive,
		initialOperations: [
			string,
			"create" | "delete" | "modify" | "rename",
		][],
		proceed: (res: boolean) => void,
	) {
		super(t.app);
		this.proceed = proceed;

		this.setTitle("Push confirmation");
		this.contentEl
			.createEl("p")
			.setText(
				"Do you want to push the following changes to Google Drive:",
			);
		const container = this.contentEl.createEl("div");

		const render = (operations: typeof initialOperations) => {
			container.empty();
			operations.map(([path, op]) => {
				const div = container.createDiv();
				div.addClass("operation-container");

				const p = div.createEl("p");
				p.createEl("b").setText(`${op[0].toUpperCase()}${op.slice(1)}`);
				p.createSpan().setText(`: ${path}`);

				if (
					op === "delete" &&
					operations.some(([file]) => path.startsWith(file + "/"))
				) {
					return;
				}

				const btn = div.createDiv().createEl("button");
				setIcon(btn, "trash-2");
				btn.onclick = async () => {
					const nestedFiles = operations
						.map(([file]) => file)
						.filter(
							(file) =>
								file.startsWith(path + "/") || file === path,
						);
					const proceed = await new Promise<boolean>((resolve) => {
						new ConfirmUndoModal(
							t,
							op,
							nestedFiles,
							resolve,
						).open();
					});

					if (!proceed) return;

					nestedFiles.forEach(
						(file) => delete t.settings.operations[file],
					);
					const newOperations = operations.filter(
						([file]) => !nestedFiles.includes(file),
					);
					if (!newOperations.length) return this.close();
					render(newOperations);
				};
			});
		};

		render(initialOperations);

		new Setting(this.contentEl)
			.addButton((btn) =>
				btn.setButtonText("Cancel").onClick(() => this.close()),
			)
			.addButton((btn) =>
				btn
					.setButtonText("Confirm")
					.setCta()
					.onClick(() => {
						proceed(true);
						this.close();
					}),
			);
	}

	onClose() {
		this.proceed(false);
	}
}

class ConfirmUndoModal extends Modal {
	proceed: (res: boolean) => void;
	t: ObsidianGoogleDrive;
	filePathToId: Record<string, string>;

	constructor(
		t: ObsidianGoogleDrive,
		operation: "create" | "delete" | "modify" | "rename",
		files: string[],
		proceed: (res: boolean) => void,
	) {
		super(t.app);
		this.t = t;
		this.filePathToId = Object.fromEntries(
			Object.entries(this.t.settings.driveIdToPath).map(([id, path]) => [
				path,
				id,
			]),
		);

		const operationMap = {
			create: "creating",
			delete: "deleting",
			modify: "modifying",
			rename: "renaming",
		};

		this.setTitle("Undo confirmation");
		this.contentEl
			.createEl("p")
			.setText(
				`Are you sure you want to undo ${operationMap[operation]} the following file(s):`,
			);
		this.contentEl.createEl("ul").append(
			...files.map((file) => {
				const li = this.contentEl.createEl("li");
				li.addClass("operation-file");
				li.setText(file);
				return li;
			}),
		);
		this.proceed = proceed;
		new Setting(this.contentEl)
			.addButton((btn) =>
				btn.setButtonText("Cancel").onClick(() => this.close()),
			)
			.addButton((btn) =>
				btn
					.setButtonText("Confirm")
					.setCta()
					.onClick(async () => {
						btn.setDisabled(true);
						if (operation === "delete") {
							await this.handleDelete(files);
						}
						if (operation === "create") {
							await this.handleCreate(files);
						}
						if (operation === "modify") {
							await this.handleModify(files);
						}
						if (operation === "rename") {
							await this.handleRename(files);
						}
						proceed(true);
						this.close();
					}),
			);
	}

	onClose() {
		this.proceed(false);
	}

	async handleDelete(paths: string[]) {
		const files = await this.t.drive.searchFiles({
			include: ["id", "mimeType", "properties", "modifiedTime"],
			matches: paths.map((path) => ({ properties: { path } })),
		});
		if (!files) {
			return new Notice("An error occurred fetching Google Drive files.");
		}

		const pathToFile = Object.fromEntries(
			files.map((file) => [file.properties.path, file]),
		);

		const deletedFolders = paths.filter(
			(path) => pathToFile[path]?.mimeType === folderMimeType,
		);

		if (deletedFolders.length) {
			const batches = foldersToBatches(deletedFolders);

			for (const batch of batches) {
				await Promise.all(
					batch.map((folder) => this.t.createFolder(folder)),
				);
			}
		}

		const deletedFiles = paths.filter(
			(path) =>
				pathToFile[path] &&
				pathToFile[path].mimeType !== folderMimeType,
		);

		await batchAsyncs(
			deletedFiles.map((path) => async () => {
				const onlineFile = await this.t.drive.getFileContent(
					this.filePathToId[path],
				);
				if (!onlineFile) {
					return new Notice(
						"An error occurred fetching Google Drive files.",
					);
				}
				return this.t.createFile(
					path,
					onlineFile,
					pathToFile[path].modifiedTime,
				);
			}),
		);
	}

	async handleCreate(paths: string[]) {
		for (const path of paths) {
			const file = this.app.vault.getAbstractFileByPath(path);
			if (file) await this.t.deleteFile(file);
		}
	}

	async handleModify(paths: string[]) {
		for (const path of paths) {
			const file = this.app.vault.getFileByPath(path);
			if (!file) continue;

			const [onlineFile, metadata] = await Promise.all([
				this.t.drive.getFileContent(this.filePathToId[path]),
				this.t.drive.getFileMetadata(this.filePathToId[path]),
			]);
			if (!onlineFile || !metadata) {
				new Notice(
					"An error occurred fetching Google Drive files.",
				);
				continue;
			}
			await this.t.modifyFile(file, onlineFile, metadata.modifiedTime);
		}
	}

	async handleRename(paths: string[]) {
		// Shallowest first: renaming a folder moves its descendants with it, so
		// descendant entries can simply be dropped once their ancestor is done.
		const ordered = [...paths].sort(
			(a, b) => a.split("/").length - b.split("/").length,
		);
		const renamedFolders: string[] = [];

		for (const path of ordered) {
			const originalPath = this.t.settings.renames[path];
			if (!originalPath) continue;
			if (
				renamedFolders.some((folder) => path.startsWith(folder + "/"))
			) {
				delete this.t.settings.renames[path];
				continue;
			}

			const file = this.app.vault.getAbstractFileByPath(path);
			if (!file) {
				delete this.t.settings.renames[path];
				continue;
			}
			try {
				await this.t.runInternalOperation(() =>
					this.app.fileManager.renameFile(file, originalPath),
				);
			} catch (error) {
				console.warn(
					"[Obsidian Gdrive Sync] Could not undo rename:",
					path,
					error,
				);
				continue;
			}
			if (file instanceof TFolder) renamedFolders.push(path);
			delete this.t.settings.renames[path];
		}
	}
}

export const push = async (
	t: ObsidianGoogleDrive,
	options?: { silent?: boolean; skipConfirm?: boolean },
) => {
	if (t.syncing) return;
	const initialOperations = Object.entries(t.settings.operations).sort(
		([a], [b]) => (a < b ? -1 : a > b ? 1 : 0),
	); // Alphabetical

	const shouldConfirm =
		t.settings.confirmPush &&
		!options?.skipConfirm &&
		initialOperations.length > 0;

	if (shouldConfirm) {
		const proceed = await new Promise<boolean>((resolve) => {
			new ConfirmPushModal(t, initialOperations, resolve).open();
		});

		if (!proceed) return;
	}

	const { vault } = t.app;
	const adapter = vault.adapter;

	let syncNotice: Notice;
	try {
		syncNotice = await t.startSync();
	} catch (error) {
		if (!options?.silent) {
			new Notice(error instanceof Error ? error.message : String(error));
		}
		return;
	}

	try {
		if ((await pull(t, true)) === false) {
			throw new Error(
				"Unable to pull the latest Google Drive state before push.",
			);
		}

		const operations = Object.entries(t.settings.operations);
		// Snapshot of the pending renames at the start of this push, so the
		// cleanup below only clears entries this run actually handled.
		const renamesSnapshot = { ...(t.settings.renames || {}) };
		const failedOperations = new Set<string>();
		const staleSkipped = new Set<string>();
		let configSyncFailed = false;
		let idDeleteFailed = false;
		// mtime of each file at the moment its content was read for upload,
		// so the cleanup below can tell whether it was saved again meanwhile.
		const uploadedMtimes = new Map<string, number>();
		const readForUpload = async (file: TFile) => {
			uploadedMtimes.set(file.path, file.stat.mtime);
			return new Blob([await vault.readBinary(file)]);
		};
		const hasFailedConfigParent = (path: string) => {
			let parent = path.split("/").slice(0, -1).join("/");
			while (parent) {
				if (failedOperations.has(parent)) return true;
				parent = parent.split("/").slice(0, -1).join("/");
			}
			return false;
		};

		const deletes = operations.filter(([_, op]) => op === "delete");
		const renames = operations.filter(([_, op]) => op === "rename");
		const creates = operations.filter(([_, op]) => op === "create");
		const modifies = operations.filter(([_, op]) => op === "modify");

		const pathsToIds = Object.fromEntries(
			Object.entries(t.settings.driveIdToPath).map(([id, path]) => [
				path,
				id,
			]),
		);

		const configOnDrive = await t.drive.searchFiles({
			include: ["id", "properties"],
			matches: [{ properties: { config: "true" } }],
		});
		if (!configOnDrive) {
			if (!options?.silent) {
				new Notice("An error occurred fetching Google Drive files.");
			}
			return;
		}

		// Reconcile config-file IDs from Drive before deleting or updating them.
		// The local mapping can be stale after a reset, reconnect, or a failed upload.
		configOnDrive.forEach(({ id, properties }) => {
			if (!properties?.path) return;
			pathsToIds[properties.path] = id;
			t.settings.driveIdToPath[id] = properties.path;
		});

		await Promise.all(
			configOnDrive.map(async ({ properties }) => {
				if (
					properties?.path &&
					!(await adapter.exists(properties.path))
				) {
					deletes.push([properties.path, "delete"]);
				}
			}),
		);

		// Newest write wins: fetch the current Drive modified time for every
		// pending path so the push below only uploads local files/folders that
		// are newer than what already exists on Drive. The same pass repairs
		// stale ids in `driveIdToPath`, so deletes/uploads never target the
		// wrong object.
		const remoteMeta = new Map<
			string,
			{ id: string; modifiedTime: string; mimeType: string }
		>();
		const lookupPaths = Array.from(
			new Set(
				operations
					.filter(
						([, op]) =>
							op === "create" ||
							op === "modify" ||
							op === "delete",
					)
					.map(([path]) => path),
			),
		);
		const LOOKUP_BATCH_SIZE = 50;
		const lookupChunks: string[][] = [];
		for (let i = 0; i < lookupPaths.length; i += LOOKUP_BATCH_SIZE) {
			lookupChunks.push(lookupPaths.slice(i, i + LOOKUP_BATCH_SIZE));
		}
		if (lookupChunks.length) {
			const remoteResults = await batchAsyncs(
				lookupChunks.map(
					(chunk) => () =>
						t.drive.searchFiles({
							include: [
								"id",
								"modifiedTime",
								"properties",
								"mimeType",
							],
							matches: chunk.map((path) => ({
								properties: { path },
							})),
						}),
				),
			);
			if (remoteResults.some((result) => result === undefined)) {
				throw new Error(
					"An error occurred fetching Google Drive files.",
				);
			}
			remoteResults.forEach((remoteFiles) => {
				remoteFiles?.forEach(
					({ id, modifiedTime, mimeType, properties }) => {
						const path = properties?.path;
						if (!path) return;
						remoteMeta.set(path, { id, modifiedTime, mimeType });
						pathsToIds[path] = id;
						t.settings.driveIdToPath[id] = path;
					},
				);
			});
		}

		if (deletes.length) {
			const deleteIds = deletes
				.map(([path]) => pathsToIds[path])
				.filter((id): id is string => Boolean(id));

			if (deleteIds.length) {
				const deleteRequest = await t.drive.batchDelete(deleteIds);
				if (!deleteRequest) {
					deletes.forEach(([path]) => {
						if (path.startsWith(vault.configDir + "/")) {
							configSyncFailed = true;
						}
						failedOperations.add(path);
					});
					if (!options?.silent) {
						new Notice(
							"An error occurred deleting Google Drive files.",
						);
					}
				} else {
					deletes.forEach(([path]) => {
						const id = pathsToIds[path];
						if (id && !deleteRequest[id]) {
							if (path.startsWith(vault.configDir + "/")) {
								configSyncFailed = true;
							}
							failedOperations.add(path);
						}
					});
				}
			}

			deletes.forEach(([path]) => {
				if (failedOperations.has(path)) return;
				const driveId = pathsToIds[path];
				if (driveId) {
					delete t.settings.driveIdToPath[driveId];
					delete pathsToIds[path];
				}
			});
		}

		// Deletes kept by Drive id rather than by path (a note renamed onto a
		// path whose previous file was still waiting to be deleted, see
		// handleRename). They have no path entry, so flush them separately.
		const pendingDeleteIds = [...(t.settings.pendingDeleteIds || [])];
		if (pendingDeleteIds.length) {
			const results = await t.drive.batchDelete(pendingDeleteIds);
			const remaining = results
				? pendingDeleteIds.filter((id) => !results[id])
				: pendingDeleteIds;
			// Ids queued by a rename made while this push was running are
			// kept as well.
			t.settings.pendingDeleteIds = Array.from(
				new Set([
					...remaining,
					...(t.settings.pendingDeleteIds || []).filter(
						(id) => !pendingDeleteIds.includes(id),
					),
				]),
			);
			if (remaining.length) {
				idDeleteFailed = true;
				if (!options?.silent) {
					new Notice("An error occurred deleting Google Drive files.");
				}
			}
		}

		syncNotice.setMessage("Syncing (33%)");

		if (renames.length) {
			const renameFolders = renames
				.map(([path]) => vault.getAbstractFileByPath(path))
				.filter((file) => file instanceof TFolder) as TFolder[];

			const renameFiles = renames
				.map(([path]) => vault.getFileByPath(path))
				.filter((file) => file instanceof TFile) as TFile[];

			// 1. Process renamed folders
			if (renameFolders.length) {
				const batches = foldersToBatches(renameFolders);
				for (const batch of batches) {
					await batchAsyncs(
						batch.map((folder) => async () => {
							const driveId = pathsToIds[folder.path];
							if (!driveId) {
								failedOperations.add(folder.path);
								return;
							}

							const newParentId =
								folder.parent && folder.parent.path !== "/"
									? pathsToIds[folder.parent.path]
									: await t.drive.getRootFolderId();
							const oldPath =
								t.settings.renames?.[folder.path] ||
								folder.path;
							const oldParentPath = oldPath
								.split("/")
								.slice(0, -1)
								.join("/");
							const oldParentId = oldParentPath
								? pathsToIds[oldParentPath]
								: await t.drive.getRootFolderId();
							if (
								(folder.parent &&
									folder.parent.path !== "/" &&
									!newParentId) ||
								(oldParentPath && !oldParentId)
							) {
								failedOperations.add(folder.path);
								return;
							}
							const parentParams =
								oldParentId &&
								newParentId &&
								oldParentId !== newParentId
									? {
											addParents: newParentId,
											removeParents: oldParentId,
										}
									: undefined;

							const result = await t.drive.updateFileMetadata(
								driveId,
								{
									name: folder.name,
									properties: { path: folder.path },
								},
								parentParams,
							);
							if (!result) failedOperations.add(folder.path);

							// Update descendant properties.path on Google Drive.
							// Batched: a folder with hundreds of notes used to
							// issue these one request at a time.
							const newPrefix = folder.path + "/";
							const descendants = Object.entries(
								t.settings.driveIdToPath,
							).filter(([, p]) => p.startsWith(newPrefix));
							const descendantResults = await batchAsyncs(
								descendants.map(
									([id, p]) =>
										() =>
											t.drive.updateFileMetadata(id, {
												properties: { path: p },
											}),
								),
								5,
							);
							if (descendantResults.some((result) => !result)) {
								failedOperations.add(folder.path);
							}
						}),
					);
				}
			}

			// 2. Process renamed files (not marked for content modification)
			if (renameFiles.length) {
				await batchAsyncs(
					renameFiles.map((file) => async () => {
						const driveId = pathsToIds[file.path];
						if (!driveId) {
							failedOperations.add(file.path);
							return;
						}

						const newParentId =
							file.parent && file.parent.path !== "/"
								? pathsToIds[file.parent.path]
								: await t.drive.getRootFolderId();
						const oldPath =
							t.settings.renames?.[file.path] || file.path;
						const oldParentPath = oldPath
							.split("/")
							.slice(0, -1)
							.join("/");
						const oldParentId = oldParentPath
							? pathsToIds[oldParentPath]
							: await t.drive.getRootFolderId();
						if (
							(file.parent &&
								file.parent.path !== "/" &&
								!newParentId) ||
							(oldParentPath && !oldParentId)
						) {
							failedOperations.add(file.path);
							return;
						}
						const parentParams =
							oldParentId &&
							newParentId &&
							oldParentId !== newParentId
								? {
										addParents: newParentId,
										removeParents: oldParentId,
									}
								: undefined;

						const result = await t.drive.updateFileMetadata(
							driveId,
							{
								name: file.name,
								properties: { path: file.path },
							},
							parentParams,
						);
						if (!result) failedOperations.add(file.path);
					}),
				);
			}
		}

		if (creates.length) {
			let completed = 0;
			const files = creates.map(([path]) =>
				vault.getAbstractFileByPath(path),
			);

			const folders = files.filter(
				(file) => file instanceof TFolder,
			) as TFolder[];

			if (folders.length) {
				const batches = foldersToBatches(folders);

				for (const batch of batches) {
					await batchAsyncs(
						batch.map((folder) => async () => {
							if (
								folder.parent &&
								folder.parent.path !== "/" &&
								!pathsToIds[folder.parent.path]
							) {
								failedOperations.add(folder.path);
								return;
							}
							if (remoteMeta.has(folder.path)) {
								// Already on Drive (confirmed above): creating it
								// again would duplicate the folder.
								return;
							}
							const id = await t.drive.createFolder({
								name: folder.name,
								parent: folder.parent
									? pathsToIds[folder.parent.path]
									: undefined,
								properties: { path: folder.path },
								modifiedTime: new Date().toISOString(),
							});
							if (!id) {
								failedOperations.add(folder.path);
								if (!options?.silent) {
									new Notice(
										"An error occurred creating Google Drive folders.",
									);
								}
								return;
							}

							completed++;
							syncNotice.setMessage(
								getSyncMessage(33, 66, completed, files.length),
							);

							t.settings.driveIdToPath[id] = folder.path;
							pathsToIds[folder.path] = id;
						}),
					);
				}
			}

			const notes = files.filter(
				(file) => file instanceof TFile,
			) as TFile[];

			await batchAsyncs(
				notes.map((note) => async () => {
					if (
						note.parent &&
						note.parent.path !== "/" &&
						!pathsToIds[note.parent.path]
					) {
						failedOperations.add(note.path);
						return;
					}
					const remote = remoteMeta.get(note.path);
					if (remote) {
						const remoteMtime = Date.parse(remote.modifiedTime);
						const localMtime = toMilliseconds(note.stat.mtime);
						// Drive already has this path: never create a second
						// copy, and only overwrite it when the local file is
						// strictly newer.
						t.settings.driveIdToPath[remote.id] = note.path;
						if (
							localMtime !== undefined &&
							!Number.isNaN(remoteMtime) &&
							localMtime <= remoteMtime
						) {
							staleSkipped.add(note.path);
							completed++;
							syncNotice.setMessage(
								getSyncMessage(33, 66, completed, files.length),
							);
							return;
						}
						const existingId = await t.drive.updateFile(
							remote.id,
							await readForUpload(note),
							{
								name: note.name,
								properties: { path: note.path },
								modifiedTime: new Date().toISOString(),
							},
						);
						if (!existingId) {
							failedOperations.add(note.path);
							if (!options?.silent) {
								new Notice(
									"An error occurred creating Google Drive files.",
								);
							}
							return;
						}
						completed++;
						syncNotice.setMessage(
							getSyncMessage(33, 66, completed, files.length),
						);
						t.settings.driveIdToPath[existingId] = note.path;
						return;
					}
					const id = await t.drive.uploadFile(
						await readForUpload(note),
						note.name,
						note.parent ? pathsToIds[note.parent.path] : undefined,
						{
							properties: { path: note.path },
							modifiedTime: new Date().toISOString(),
						},
					);
					if (!id) {
						failedOperations.add(note.path);
						if (!options?.silent) {
							new Notice(
								"An error occurred creating Google Drive files.",
							);
						}
						return;
					}

					completed++;
					syncNotice.setMessage(
						getSyncMessage(33, 66, completed, files.length),
					);

					t.settings.driveIdToPath[id] = note.path;
				}),
			);
		}

		if (modifies.length) {
			let completed = 0;

			const files = modifies
				.map(([path]) => vault.getFileByPath(path))
				.filter((file) => file instanceof TFile) as TFile[];

			const pathToId = Object.fromEntries(
				Object.entries(t.settings.driveIdToPath).map(([id, path]) => [
					path,
					id,
				]),
			);

			await batchAsyncs(
				files.map((file) => async () => {
					const driveId = pathToId[file.path];

					const remote = remoteMeta.get(file.path);
					if (remote) {
						const remoteMtime = Date.parse(remote.modifiedTime);
						const localMtime = toMilliseconds(file.stat.mtime);
						if (
							localMtime !== undefined &&
							!Number.isNaN(remoteMtime) &&
							localMtime <= remoteMtime
						) {
							// Drive already holds this version (or a newer
							// one): skip instead of clobbering it.
							staleSkipped.add(file.path);
							completed++;
							syncNotice.setMessage(
								getSyncMessage(66, 99, completed, files.length),
							);
							return;
						}
					}

					const newParentId =
						file.parent && file.parent.path !== "/"
							? pathToId[file.parent.path]
							: undefined;
					if (
						file.parent &&
						file.parent.path !== "/" &&
						!newParentId
					) {
						failedOperations.add(file.path);
						return;
					}
					const oldPath =
						t.settings.renames?.[file.path] || file.path;
					const oldParentPath = oldPath
						.split("/")
						.slice(0, -1)
						.join("/");
					const oldParentId = oldParentPath
						? pathToId[oldParentPath]
						: undefined;
					const parentParams =
						oldParentId &&
						newParentId &&
						oldParentId !== newParentId
							? {
									addParents: newParentId,
									removeParents: oldParentId,
								}
							: undefined;

					// SAFETY CHECK: If the file doesn't have a Drive ID yet, upload it as a new file instead of throwing a 404
					if (!driveId) {
						const newId = await t.drive.uploadFile(
							await readForUpload(file),
							file.name,
							file.parent
								? pathToId[file.parent.path]
								: undefined,
							{
								properties: { path: file.path },
								modifiedTime: new Date().toISOString(),
							},
						);
						if (newId) {
							t.settings.driveIdToPath[newId] = file.path;
							pathToId[file.path] = newId;
						} else {
							failedOperations.add(file.path);
						}
						completed++;
						return;
					}

					const update = await t.drive.tryUpdateFile(
						driveId,
						await readForUpload(file),
						{
							name: file.name,
							properties: { path: file.path },
							modifiedTime: new Date().toISOString(),
						},
						parentParams,
					);
					if (!update.ok && update.status !== 404) {
						// Rate limit, 5xx, timeout: the Drive object is still
						// there, so uploading a "new" copy would duplicate it.
						// Leave the operation queued for the next sync.
						failedOperations.add(file.path);
						if (!options?.silent) {
							new Notice(`Failed to upload ${file.path}.`);
						}
						return;
					}
					let id = update.ok ? update.value : undefined;
					if (!id) {
						// The remote file is gone (404): re-upload as a new file
						if (
							file.parent &&
							file.parent.path !== "/" &&
							!newParentId
						) {
							failedOperations.add(file.path);
							return;
						}
						id = await t.drive.uploadFile(
							await readForUpload(file),
							file.name,
							file.parent && file.parent.path !== "/"
								? pathToId[file.parent.path]
								: undefined,
							{
								properties: { path: file.path },
								modifiedTime: new Date().toISOString(),
							},
						);
						if (id) {
							delete t.settings.driveIdToPath[driveId];
							t.settings.driveIdToPath[id] = file.path;
							pathToId[file.path] = id;
						} else if (!options?.silent) {
							failedOperations.add(file.path);
							return new Notice(
								`Failed to modify or re-upload file: ${file.path}`,
							);
						} else {
							failedOperations.add(file.path);
						}
					}

					completed++;
					syncNotice.setMessage(
						getSyncMessage(66, 99, completed, files.length),
					);
				}),
			);
		}

		const configFilesToSync = await t.drive.getConfigFilesToSync();
		if (!configFilesToSync) {
			if (!options?.silent) {
				return new Notice(
					"An error occurred fetching Google Drive config files.",
				);
			}
			return;
		}

		// Ensure latest settings are written locally before syncing config
		await t.saveSettings();

		const settingsFilePath = t.getSettingsFilePath();
		if (
			!configFilesToSync.includes(settingsFilePath) &&
			(await adapter.exists(settingsFilePath))
		) {
			configFilesToSync.push(settingsFilePath);
		}

		const foldersToCreate = new Set<string>();
		configFilesToSync.forEach((path) => {
			const parts = path.split("/");
			for (let i = 1; i < parts.length; i++) {
				foldersToCreate.add(parts.slice(0, i).join("/"));
			}
		});

		foldersToCreate.forEach((folder) => {
			if (pathsToIds[folder]) foldersToCreate.delete(folder);
		});

		if (foldersToCreate.size) {
			const batches = foldersToBatches(Array.from(foldersToCreate));

			for (const batch of batches) {
				await batchAsyncs(
					batch.map((folder) => async () => {
						const parentPath = folder
							.split("/")
							.slice(0, -1)
							.join("/");
						if (parentPath && !pathsToIds[parentPath]) {
							configSyncFailed = true;
							failedOperations.add(folder);
							return;
						}
						const id = await t.drive.createFolder({
							name: folder.split("/").pop() || "",
							parent: pathsToIds[
								folder.split("/").slice(0, -1).join("/")
							],
							properties: { path: folder, config: "true" },
							modifiedTime: new Date().toISOString(),
						});
						if (!id) {
							configSyncFailed = true;
							failedOperations.add(folder);
							if (!options?.silent) {
								return new Notice(
									"An error occurred creating Google Drive folders.",
								);
							}
							return;
						}

						t.settings.driveIdToPath[id] = folder;
						pathsToIds[folder] = id;
					}),
				);
			}
		}

		const uploadConfigFile = async (path: string, content: Blob) => {
			if (hasFailedConfigParent(path)) {
				configSyncFailed = true;
				failedOperations.add(path);
				return;
			}
			if (pathsToIds[path]) {
				const result = await t.drive.updateFile(
					pathsToIds[path],
					content,
					{
						name: fileNameFromPath(path),
						modifiedTime: new Date().toISOString(),
					},
				);
				if (!result) {
					configSyncFailed = true;
					failedOperations.add(path);
				}
				return;
			}

			const parentPath = path.split("/").slice(0, -1).join("/");
			const parentId = parentPath ? pathsToIds[parentPath] : undefined;
			if (parentPath && !parentId) {
				// Without a parent id uploadFile would fall back to the vault
				// root on Drive and misplace the file.
				configSyncFailed = true;
				failedOperations.add(path);
				return;
			}
			const id = await t.drive.uploadFile(
				content,
				fileNameFromPath(path),
				parentId,
				{
					properties: { path, config: "true" },
					modifiedTime: new Date().toISOString(),
				},
			);
			if (!id) {
				configSyncFailed = true;
				failedOperations.add(path);
				if (!options?.silent) {
					new Notice(
						"An error occurred creating Google Drive config files.",
					);
				}
				return;
			}

			t.settings.driveIdToPath[id] = path;
			pathsToIds[path] = id;
		};

		await batchAsyncs(
			configFilesToSync
				// This plugin's own data.json is uploaded once, further down,
				// after the queue has been cleaned up; it used to be uploaded
				// here and then again immediately afterwards.
				.filter((path) => path !== settingsFilePath)
				.map((path) => async () => {
					await uploadConfigFile(
						path,
						new Blob([await adapter.readBinary(path)]),
					);
				}),
		);

		// Clear only the operations/renames that this run handled successfully.
		// Anything recorded by a user edit while the push was running is left
		// untouched so it is picked up by the next sync instead of being
		// silently discarded.
		for (const [path, operation] of operations) {
			if (failedOperations.has(path)) continue;
			if (t.settings.operations[path] !== operation) continue;
			// A save that landed while this file was uploading leaves the
			// operation unchanged ("modify" stays "modify"), so also compare
			// the mtime that was read for the upload with the current one.
			const uploadedMtime = uploadedMtimes.get(path);
			const current = vault.getFileByPath(path);
			if (
				uploadedMtime !== undefined &&
				current &&
				current.stat.mtime !== uploadedMtime
			) {
				continue;
			}
			delete t.settings.operations[path];
		}
		for (const [path, original] of Object.entries(renamesSnapshot)) {
			if (failedOperations.has(path)) continue;
			if (t.settings.renames[path] === original) {
				delete t.settings.renames[path];
			}
		}
		await t.saveSettings();

		// Upload this plugin's settings exactly once, now that the handled
		// operations are cleared and every new Drive id is in the map, so the
		// copy on Drive (which a new device starts from) is consistent.
		await uploadConfigFile(
			settingsFilePath,
			new Blob([JSON.stringify(t.getSettingsForSync(), null, 2)]),
		);

		if (configSyncFailed) {
			throw new Error(
				"One or more Obsidian configuration files failed to sync.",
			);
		}

		const pushedSuccessfully =
			failedOperations.size === 0 && !idDeleteFailed;
		await t.endSync(syncNotice, false, pushedSuccessfully);

		if (staleSkipped.size) {
			console.info(
				"[Obsidian Gdrive Sync] Skipped file(s) that were newer on Google Drive:",
				Array.from(staleSkipped),
			);
		}

		if (!options?.silent) {
			if (pushedSuccessfully) {
				new Notice("Sync complete!");
			} else {
				new Notice(
					`Sync incomplete: ${failedOperations.size} item(s) could not be pushed and will be retried.`,
				);
			}
		}
	} catch (error) {
		console.error("[Obsidian Gdrive Sync] Push error:", error);
		if (!options?.silent) {
			new Notice(
				`Sync failed: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
	} finally {
		t.pendingChangesToken = undefined;
		t.syncing = false;
		t.ribbonIcon?.removeClass("spin");
		syncNotice?.hide();
	}
};
