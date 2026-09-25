import ObsidianGoogleDrive from "main";
import {
	batchAsyncs,
	folderMimeType,
	foldersToBatches,
	getSyncMessage,
} from "./drive";
import { Notice, TAbstractFile, TFile, Modal, Setting } from "obsidian";
import { pull } from "./pull";

export class ConfirmResetModal extends Modal {
	proceed: (res: boolean) => void;
	constructor(t: ObsidianGoogleDrive, proceed: (res: boolean) => void) {
		super(t.app);
		this.proceed = proceed;

		this.setTitle(
			"Are you sure you want to reset the data from Google Drive?",
		);
		this.setContent(
			"You'll loose all the local changes to your data and load only the information on your google drive. This step is irreversible.",
		);
		new Setting(this.contentEl)
			.addButton((btn) =>
				btn.setButtonText("Cancel").onClick(() => this.close()),
			)
			.addButton((btn) =>
				btn
					.setButtonText("RESET!")
					.setWarning()
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

export const reset = async (t: ObsidianGoogleDrive) => {
	if (t.syncing) return;

	const proceed = await new Promise<boolean>((resolve) => {
		new ConfirmResetModal(t, resolve).open();
	});
	if (!proceed) return;

	let syncNotice: Notice;
	try {
		syncNotice = await t.startSync();
	} catch (error) {
		new Notice(error instanceof Error ? error.message : String(error));
		return;
	}

	try {
		const pullResult = await pull(t, true);
		if (pullResult === false) {
			throw new Error(
				"Unable to pull the latest Google Drive state before reset.",
			);
		}

		const { vault } = t.app;

		const operations = Object.entries(t.settings.operations);
		const deletes = operations.filter(([_, op]) => op === "delete");
		const creates = operations.filter(([_, op]) => op === "create");
		const modifies = operations.filter(([_, op]) => op === "modify");

		const filePathToId = Object.fromEntries(
			Object.entries(t.settings.driveIdToPath).map(([id, path]) => [
				path,
				id,
			]),
		);

		if (creates.length) {
			const deleteResults = await t.drive.deleteFilesMinimumOperations(
				creates
					.map(([path]) => vault.getAbstractFileByPath(path))
					.filter(
						(file) => file instanceof TAbstractFile,
					) as TAbstractFile[],
			);
			if (
				!deleteResults ||
				Object.values(deleteResults).some((result) => !result)
			) {
				throw new Error(
					"Unable to remove all local changes during reset.",
				);
			}
		}

		syncNotice.setMessage("Syncing (33%)");

		if (modifies.length) {
			let completed = 0;
			const files = modifies
				.map(([path]) => vault.getFileByPath(path))
				.filter((file): file is TFile => file instanceof TFile);
			const results = await batchAsyncs(
				files.map((file) => async () => {
					const [onlineFile, metadata] = await Promise.all([
						t.drive.getFileContent(filePathToId[file.path]),
						t.drive.getFileMetadata(filePathToId[file.path]),
					]);
					if (!onlineFile || !metadata) {
						return new Notice(
							"An error occurred fetching Google Drive files.",
						);
					}

					completed++;
					syncNotice.setMessage(
						getSyncMessage(33, 66, completed, files.length),
					);
					return t.modifyFile(
						file,
						onlineFile,
						metadata.modifiedTime,
					);
				}),
			);
			if (results.some((result) => result instanceof Notice)) {
				throw new Error(
					"Unable to restore all modified files during reset.",
				);
			}
		}

		if (deletes.length) {
			const files = await t.drive.searchFiles({
				include: ["id", "mimeType", "properties", "modifiedTime"],
				matches: deletes.map(([path]) => ({ properties: { path } })),
			});
			if (!files) {
				throw new Error(
					"An error occurred fetching Google Drive files.",
				);
			}

			const pathToFile = Object.fromEntries(
				files.map((file) => [file.properties.path, file]),
			);

			// Refuse to report success while some deleted files could not be
			// found on Drive (and therefore cannot be restored).
			const missing = deletes.filter(([path]) => !pathToFile[path]);
			if (missing.length) {
				throw new Error(
					`Unable to locate ${missing.length} file(s) on Google Drive during reset: ${missing
						.map(([path]) => path)
						.join(", ")}`,
				);
			}

			const deletedFolders = deletes.filter(
				([path]) => pathToFile[path]?.mimeType === folderMimeType,
			);

			if (deletedFolders.length) {
				const batches = foldersToBatches(
					deletedFolders.map(([path]) => path),
				);

				for (const batch of batches) {
					await Promise.all(
						batch.map((folder) => t.createFolder(folder)),
					);
				}
			}

			let completed = 0;

			const deletedFiles = deletes.filter(
				([path]) =>
					pathToFile[path] &&
					pathToFile[path].mimeType !== folderMimeType,
			);

			const results = await batchAsyncs(
				deletedFiles.map(([path]) => async () => {
					const onlineFile = await t.drive.getFileContent(
						filePathToId[path],
					);
					if (!onlineFile) {
						return new Notice(
							"An error occurred fetching Google Drive files.",
						);
					}
					completed++;
					syncNotice.setMessage(
						getSyncMessage(66, 99, completed, deletedFiles.length),
					);
					return t.createFile(
						path,
						onlineFile,
						pathToFile[path].modifiedTime,
					);
				}),
			);
			if (results.some((result) => result instanceof Notice)) {
				throw new Error(
					"Unable to restore all deleted files during reset.",
				);
			}
		}

		await t.endSync(syncNotice);
		t.settings.operations = {};
		t.settings.renames = {};
		await t.saveSettings();

		new Notice("Reset complete.");
	} catch (error) {
		console.error("[Obsidian Gdrive Sync] Reset error:", error);
		new Notice(
			`Reset failed: ${error instanceof Error ? error.message : String(error)}`,
		);
	} finally {
		t.pendingChangesToken = undefined;
		t.syncing = false;
		t.ribbonIcon?.removeClass("spin");
		syncNotice?.hide();
	}
};
