import { checkConnection, getDriveClient } from "helpers/drive";
import {
	OAuthCredentials,
	refreshAccessTokenWithRefreshToken,
} from "helpers/deviceAuth";
import { pull } from "helpers/pull";
import { push } from "helpers/push";
import { reset } from "helpers/reset";
import { randomUUID } from "helpers/util";
import { DeviceAuthModal } from "deviceAuthModal";
import {
	App,
	debounce,
	Notice,
	Plugin,
	PluginSettingTab,
	Setting,
	TAbstractFile,
	TFile,
	Menu,
} from "obsidian";

interface PluginSettings {
	vaultId: string;
	clientId: string;
	clientSecret: string;
	refreshToken: string;
	operations: Record<string, "create" | "delete" | "modify" | "rename">;
	renames: Record<string, string>;
	driveIdToPath: Record<string, string>;
	lastSyncedAt: number;
	changesToken: string;
	syncOnSave: boolean;
	syncOnSaveDelay: number;
	confirmPush: boolean;
	ribbonAction: "sync" | "menu";
	/**
	 * Whether the one-time migration that stamps `vaultId` onto an existing
	 * (pre-vaultId) Google Drive tree has been performed for this vault.
	 */
	vaultIdMigrated: boolean;
}

const DEFAULT_SETTINGS: PluginSettings = {
	vaultId: "",
	clientId: "",
	clientSecret: "",
	refreshToken: "",
	operations: {},
	renames: {},
	driveIdToPath: {},
	lastSyncedAt: 0,
	changesToken: "",
	syncOnSave: true,
	syncOnSaveDelay: 2,
	confirmPush: false,
	ribbonAction: "sync",
	vaultIdMigrated: false,
};

export default class ObsidianGoogleDrive extends Plugin {
	settings!: PluginSettings;
	accessToken = {
		token: "",
		expiresAt: 0,
	};
	drive = getDriveClient(this);
	ribbonIcon?: HTMLElement;
	/**
	 * Set when a touch long-press opened the ribbon menu, so the click that the
	 * touch sequence fires afterwards does not also start a sync.
	 */
	private suppressNextRibbonClick = false;
	syncing = false;
	pendingChangesToken?: string;

	/**
	 * Depth counter of vault mutations that the plugin is performing itself
	 * (for example writing files pulled from Google Drive). Obsidian fires
	 * vault events synchronously from inside these calls, so while the counter
	 * is non-zero the event handlers must ignore them instead of recording
	 * them as user edits.
	 *
	 * This is deliberately separate from `syncing`: user edits that happen while
	 * a sync is running are still real changes and must be recorded.
	 */
	private internalOperationCount = 0;

	/** True while the plugin is mutating the vault on its own behalf. */
	isApplyingRemoteChange() {
		return this.internalOperationCount > 0;
	}

	/**
	 * Runs a vault mutation that originated from the sync engine (pull/push/reset)
	 * so the resulting vault events are not mistaken for user edits.
	 */
	async runInternalOperation<T>(operation: () => Promise<T>): Promise<T> {
		this.internalOperationCount++;
		try {
			return await operation();
		} finally {
			this.internalOperationCount--;
		}
	}

	private refreshPromise: Promise<boolean> | null = null;
	private syncFeaturesRegistered = false;
	debouncedSyncOnSave!: (() => void) & { cancel?: () => void };

	async onload() {
		await this.loadSettings();

		this.updateSyncOnSaveDebounce();

		this.addSettingTab(new SettingsTab(this.app, this));

		this.registerSyncFeatures();

		if (
			!this.settings.clientId ||
			!this.settings.clientSecret ||
			!this.settings.refreshToken
		) {
			new Notice(
				"Obsidian Gdrive Sync: Enter your OAuth credentials and connect your Google account in settings to start syncing.",
				8000,
			);
			return;
		}

		checkConnection().then(async (connected) => {
			if (connected) {
				try {
					this.syncing = true;
					this.ribbonIcon?.addClass("spin");
					if ((await pull(this, true)) === false) {
						throw new Error("Unable to complete startup pull.");
					}
					await this.endSync();
				} catch (error) {
					this.pendingChangesToken = undefined;
					console.error(
						"[Obsidian Gdrive Sync] Startup pull error:",
						error,
					);
				} finally {
					this.syncing = false;
					this.ribbonIcon?.removeClass("spin");
				}
			}
		});
	}

	onunload() {
		return this.saveSettings();
	}

	updateSyncOnSaveDebounce() {
		const delayMs = Math.max(
			500,
			(this.settings.syncOnSaveDelay || 2) * 1000,
		);
		this.debouncedSyncOnSave = debounce(
			() => {
				if (!this.settings.syncOnSave) return;
				if (!this.settings.refreshToken) return;
				if (this.syncing) {
					this.debouncedSyncOnSave();
					return;
				}
				this.runSync({ silent: true, skipConfirm: true });
			},
			delayMs,
			true,
		);
	}

	registerSyncFeatures() {
		if (this.syncFeaturesRegistered) return;
		this.syncFeaturesRegistered = true;

		const { vault } = this.app;

		this.registerRibbonIcon();

		this.addCommand({
			id: "sync",
			name: "Sync with Google Drive",
			callback: () => this.runSync(),
		});

		this.addCommand({
			id: "push",
			name: "Push to Google Drive",
			callback: () => push(this),
		});

		this.addCommand({
			id: "pull",
			name: "Pull from Google Drive",
			callback: () => pull(this),
		});

		this.addCommand({
			id: "reset",
			name: "Reset local vault to Google Drive",
			callback: () => reset(this),
		});

		this.registerEvent(
			this.app.workspace.on("quit", () => this.saveSettings()),
		);

		this.app.workspace.onLayoutReady(() => {
			this.registerEvent(
				vault.on("create", this.handleCreate.bind(this)),
			);
		});
		this.registerEvent(vault.on("delete", this.handleDelete.bind(this)));
		this.registerEvent(vault.on("modify", this.handleModify.bind(this)));
		this.registerEvent(vault.on("rename", this.handleRename.bind(this)));
	}

	registerRibbonIcon() {
		if (this.ribbonIcon) return;

		const ribbonIcon = this.addRibbonIcon(
			"refresh-cw",
			"Sync with Google Drive (long-press / right-click for options)",
			(event: MouseEvent) => {
				if (event.button === 2) {
					this.showSyncMenu(event);
					return;
				}
				// A touch long-press already opened the menu; ignore the click
				// the same gesture fires afterwards.
				if (this.suppressNextRibbonClick) {
					this.suppressNextRibbonClick = false;
					return;
				}
				if (this.settings.ribbonAction === "menu") {
					this.showSyncMenu(event);
				} else {
					this.runSync();
				}
			},
		);
		this.ribbonIcon = ribbonIcon;

		this.registerDomEvent(
			ribbonIcon,
			"contextmenu",
			(event: MouseEvent) => {
				event.preventDefault();
				this.showSyncMenu(event);
			},
		);

		// Touch devices (iOS WKWebView in particular) do not reliably fire
		// `contextmenu`, so a long-press opens the same menu at the touch
		// point.
		let longPressTimer: number | undefined;
		const cancelLongPress = () => {
			if (longPressTimer !== undefined) {
				window.clearTimeout(longPressTimer);
				longPressTimer = undefined;
			}
		};
		this.registerDomEvent(
			ribbonIcon,
			"touchstart",
			(event: TouchEvent) => {
				const touch = event.touches[0];
				if (!touch) return;
				cancelLongPress();
				longPressTimer = window.setTimeout(() => {
					longPressTimer = undefined;
					this.suppressNextRibbonClick = true;
					this.showSyncMenuAt({
						x: touch.clientX,
						y: touch.clientY,
					});
				}, 500);
			},
		);
		this.registerDomEvent(ribbonIcon, "touchend", cancelLongPress);
		this.registerDomEvent(ribbonIcon, "touchmove", cancelLongPress);
		this.registerDomEvent(ribbonIcon, "touchcancel", cancelLongPress);
	}

	showSyncMenu(event: MouseEvent) {
		this.openSyncMenu((menu) => menu.showAtMouseEvent(event));
	}

	showSyncMenuAt(position: { x: number; y: number }) {
		this.openSyncMenu((menu) => menu.showAtPosition(position));
	}

	private openSyncMenu(show: (menu: Menu) => void) {
		if (this.syncing) return;
		const menu = new Menu();

		menu.addItem((item) =>
			item
				.setTitle("Sync now")
				.setIcon("refresh-cw")
				.onClick(() => {
					this.runSync();
				}),
		);

		menu.addItem((item) =>
			item
				.setTitle("Pull from Drive")
				.setIcon("cloud-download")
				.onClick(() => {
					pull(this);
				}),
		);

		menu.addItem((item) =>
			item
				.setTitle("Push to Drive")
				.setIcon("cloud-upload")
				.onClick(() => {
					push(this);
				}),
		);

		menu.addItem((item) =>
			item
				.setTitle("Reset from Drive")
				.setIcon("triangle-alert")
				.onClick(() => {
					reset(this);
				}),
		);

		show(menu);
	}

	async runSync(options?: { silent?: boolean; skipConfirm?: boolean }) {
		if (this.syncing) {
			if (!options?.silent) {
				new Notice("Google Drive sync is already in progress.");
			}
			return;
		}

		if (
			!this.settings.refreshToken ||
			!this.settings.clientId ||
			!this.settings.clientSecret
		) {
			if (!options?.silent) {
				new Notice(
					"Please connect your Google Drive account in settings first.",
				);
			}
			return;
		}

		await push(this, options);
	}

	async loadSettings() {
		const loaded = (await this.loadData()) || {};
		this.settings = Object.assign({}, DEFAULT_SETTINGS, loaded, {
			// Copy the mutable maps so a data.json missing one of these keys
			// can never end up aliasing (and mutating) DEFAULT_SETTINGS.
			operations: { ...(loaded.operations || {}) },
			renames: { ...(loaded.renames || {}) },
			driveIdToPath: { ...(loaded.driveIdToPath || {}) },
		});
		if (!this.settings.vaultId) {
			this.settings.vaultId = randomUUID();
			await this.saveSettings();
		}
	}

	saveSettings() {
		return this.saveData(this.settings);
	}

	getSettingsFilePath() {
		return (
			this.app.vault.configDir + `/plugins/${this.manifest.id}/data.json`
		);
	}

	getSettingsForSync() {
		const settings: Record<string, unknown> = { ...this.settings };
		delete settings.clientId;
		delete settings.clientSecret;
		// Never upload the long-lived refresh token. It grants full access to
		// the Drive account and should stay on the device that owns it.
		delete settings.refreshToken;
		return settings;
	}

	mergeSyncedSettings(content: ArrayBuffer) {
		try {
			const syncedSettings = JSON.parse(
				new TextDecoder().decode(content),
			);
			return new TextEncoder().encode(
				JSON.stringify(
					{
						...syncedSettings,
						clientId: this.settings.clientId,
						clientSecret: this.settings.clientSecret,
						// Keep this device's own OAuth token; synced settings
						// deliberately do not carry it.
						refreshToken: this.settings.refreshToken,
					},
					null,
					2,
				),
			).buffer;
		} catch {
			return content;
		}
	}

	debouncedSaveSettings = debounce(this.saveSettings.bind(this), 500, true);

	// Refreshes the in-memory access token using mutex locking to avoid duplicate concurrent calls
	async refreshAccessToken(): Promise<boolean> {
		if (this.refreshPromise) {
			return this.refreshPromise;
		}

		this.refreshPromise = (async () => {
			try {
				if (
					!this.settings.refreshToken ||
					!this.settings.clientId ||
					!this.settings.clientSecret
				)
					return false;
				const { access_token, expires_in } =
					await refreshAccessTokenWithRefreshToken(
						this.settings.refreshToken,
						this.getOAuthCredentials(),
					);
				this.accessToken = {
					token: access_token,
					expiresAt: Date.now() + expires_in * 1000,
				};
				return true;
			} catch (error) {
				console.error(
					"[Obsidian Gdrive Sync] Failed to refresh access token:",
					error,
				);
				new Notice(
					"Failed to refresh Google Drive access. You may need to reconnect your account in settings.",
				);
				return false;
			} finally {
				this.refreshPromise = null;
			}
		})();

		return this.refreshPromise;
	}

	getOAuthCredentials(): OAuthCredentials {
		return {
			clientId: this.settings.clientId,
			clientSecret: this.settings.clientSecret,
		};
	}

	handleCreate(file: TAbstractFile) {
		if (this.isApplyingRemoteChange()) return;
		if (!this.settings.renames) this.settings.renames = {};

		if (this.settings.operations[file.path] === "delete") {
			if (file instanceof TFile) {
				this.settings.operations[file.path] = "modify";
			} else {
				delete this.settings.operations[file.path];
			}
		} else {
			this.settings.operations[file.path] = "create";
		}
		this.debouncedSaveSettings();
		if (this.settings.syncOnSave) this.debouncedSyncOnSave();
	}

	handleDelete(file: TAbstractFile) {
		if (this.isApplyingRemoteChange()) return;
		if (!this.settings.renames) this.settings.renames = {};

		// If this file had a pending rename from an original Drive path,
		// clean up the rename and mark the original path for deletion
		const originalPath = this.settings.renames[file.path];
		delete this.settings.renames[file.path];

		if (this.settings.operations[file.path] === "create") {
			delete this.settings.operations[file.path];
		} else {
			const targetPath = originalPath || file.path;
			this.settings.operations[targetPath] = "delete";
			if (originalPath && originalPath !== file.path) {
				delete this.settings.operations[file.path];
			}
		}
		this.debouncedSaveSettings();
		if (this.settings.syncOnSave) this.debouncedSyncOnSave();
	}

	handleModify(file: TAbstractFile) {
		if (this.isApplyingRemoteChange()) return;
		if (!(file instanceof TFile)) return;
		if (!this.settings.renames) this.settings.renames = {};

		const operation = this.settings.operations[file.path];
		// If it was already "create", keep "create" (content is uploaded on creation).
		// If it was "rename", keep it marked as "modify" so push uploads the new content,
		// while this.settings.renames[file.path] preserves the rename metadata!
		if (operation !== "create" && operation !== "modify") {
			this.settings.operations[file.path] = "modify";
			this.debouncedSaveSettings();
		}
		if (this.settings.syncOnSave) this.debouncedSyncOnSave();
	}

	handleRename(file: TAbstractFile, oldPath: string) {
		if (this.isApplyingRemoteChange()) return;
		if (!this.settings.renames) this.settings.renames = {};

		// Check if oldPath already has an existing Drive ID
		const existingDriveId = Object.entries(
			this.settings.driveIdToPath,
		).find(([_, p]) => p === oldPath)?.[0];

		// Case A: Newly created item that has NOT yet synced to Google Drive
		if (
			this.settings.operations[oldPath] === "create" &&
			!existingDriveId
		) {
			delete this.settings.operations[oldPath];
			this.settings.operations[file.path] = "create";

			if (!(file instanceof TFile)) {
				const oldPrefix = oldPath + "/";
				const newPrefix = file.path + "/";
				for (const [opPath, op] of Object.entries(
					this.settings.operations,
				)) {
					if (opPath.startsWith(oldPrefix)) {
						delete this.settings.operations[opPath];
						this.settings.operations[
							newPrefix + opPath.slice(oldPrefix.length)
						] = op;
					}
				}
			}
			this.debouncedSaveSettings();
			if (this.settings.syncOnSave) this.debouncedSyncOnSave();
			return;
		}

		// Case B: Item already exists on Google Drive (or child of synced item)
		const originalPath = this.settings.renames[oldPath] || oldPath;
		delete this.settings.renames[oldPath];
		if (originalPath !== file.path) {
			this.settings.renames[file.path] = originalPath;
		}

		// Update driveIdToPath for the renamed item itself
		if (existingDriveId) {
			this.settings.driveIdToPath[existingDriveId] = file.path;
		}

		// Preserve previous operation: if content was already modified, keep "modify"
		// so push knows to upload new content AND update metadata;
		// otherwise mark as "rename".
		const oldOp = this.settings.operations[oldPath];
		delete this.settings.operations[oldPath];
		if (oldOp === "modify") {
			this.settings.operations[file.path] = "modify";
		} else {
			this.settings.operations[file.path] = "rename";
		}

		// If a folder was renamed, update subpaths in driveIdToPath, renames, and operations
		if (!(file instanceof TFile)) {
			const oldPrefix = oldPath + "/";
			const newPrefix = file.path + "/";

			for (const [id, p] of Object.entries(this.settings.driveIdToPath)) {
				if (p.startsWith(oldPrefix)) {
					this.settings.driveIdToPath[id] =
						newPrefix + p.slice(oldPrefix.length);
				}
			}

			for (const [rPath, original] of Object.entries(
				this.settings.renames,
			)) {
				if (rPath.startsWith(oldPrefix)) {
					delete this.settings.renames[rPath];
					this.settings.renames[
						newPrefix + rPath.slice(oldPrefix.length)
					] = original;
				}
			}

			for (const [opPath, op] of Object.entries(
				this.settings.operations,
			)) {
				if (opPath.startsWith(oldPrefix)) {
					delete this.settings.operations[opPath];
					this.settings.operations[
						newPrefix + opPath.slice(oldPrefix.length)
					] = op;
				}
			}
		}

		this.debouncedSaveSettings();
		if (this.settings.syncOnSave) this.debouncedSyncOnSave();
	}

	async createFolder(path: string) {
		const oldOperation = this.settings.operations[path];
		await this.runInternalOperation(() => this.app.vault.createFolder(path));
		this.settings.operations[path] = oldOperation;
		if (!oldOperation) delete this.settings.operations[path];
	}

	async createFile(
		path: string,
		content: ArrayBuffer,
		modificationDate?: number | string | Date,
	) {
		const oldOperation = this.settings.operations[path];
		if (typeof modificationDate === "string") {
			modificationDate = new Date(modificationDate);
		}
		if (modificationDate instanceof Date) {
			modificationDate = modificationDate.getTime();
		}

		await this.runInternalOperation(() =>
			this.app.vault.createBinary(path, content, {
				mtime: modificationDate,
			}),
		);
		this.settings.operations[path] = oldOperation;
		if (!oldOperation) delete this.settings.operations[path];
	}

	async modifyFile(
		file: TFile,
		content: ArrayBuffer,
		modificationDate?: number | string | Date,
	) {
		const oldOperation = this.settings.operations[file.path];
		if (typeof modificationDate === "string") {
			modificationDate = new Date(modificationDate);
		}
		if (modificationDate instanceof Date) {
			modificationDate = modificationDate.getTime();
		}

		await this.runInternalOperation(() =>
			this.app.vault.modifyBinary(file, content, {
				mtime: modificationDate,
			}),
		);
		this.settings.operations[file.path] = oldOperation;
		if (!oldOperation) delete this.settings.operations[file.path];
	}

	async upsertFile(
		file: string,
		content: ArrayBuffer,
		modificationDate?: number | string | Date,
	) {
		const oldOperation = this.settings.operations[file];
		if (typeof modificationDate === "string") {
			modificationDate = new Date(modificationDate);
		}
		if (modificationDate instanceof Date) {
			modificationDate = modificationDate.getTime();
		}

		await this.runInternalOperation(() =>
			this.app.vault.adapter.writeBinary(file, content, {
				mtime: modificationDate,
			}),
		);
		this.settings.operations[file] = oldOperation;
		if (!oldOperation) delete this.settings.operations[file];
	}

	async deleteFile(file: TAbstractFile): Promise<boolean> {
		try {
			if (this.app.vault.getAbstractFileByPath(file.path)) {
				await this.runInternalOperation(() =>
					this.app.fileManager.trashFile(file),
				);
			}
		} catch (error) {
			console.warn(
				"[Obsidian Gdrive Sync] File already removed or unable to trash:",
				file.path,
				error,
			);
			return false;
		}
		delete this.settings.operations[file.path];
		return true;
	}

	async startSync() {
		if (
			!this.settings.refreshToken ||
			!this.settings.clientId ||
			!this.settings.clientSecret
		) {
			throw new Error(
				"Google Drive OAuth credentials are missing. Enter them in plugin settings first.",
			);
		}
		if (!(await checkConnection())) {
			throw new Error(
				"You are not connected to the internet, so you cannot sync right now. Please try syncing once you have connection again.",
			);
		}
		this.ribbonIcon?.addClass("spin");
		this.syncing = true;
		return new Notice("Syncing (0%)", 0);
	}

	async endSync(
		syncNotice?: Notice,
		retainConfigChanges = true,
		markSynced = true,
	) {
		try {
			if (retainConfigChanges) {
				const configFilesToSync =
					await this.drive.getConfigFilesToSync();
				if (!configFilesToSync) {
					throw new Error(
						"An error occurred fetching Google Drive config files.",
					);
				}

				await Promise.all(
					configFilesToSync.map(async (file) =>
						this.app.vault.adapter.writeBinary(
							file,
							await this.app.vault.adapter.readBinary(file),
							{ mtime: Date.now() },
						),
					),
				);
			}

			if (!this.settings.changesToken) {
				const changesToken = await this.drive.getChangesStartToken();
				if (changesToken) {
					this.settings.changesToken = changesToken;
				}
			}
			if (this.pendingChangesToken) {
				this.settings.changesToken = this.pendingChangesToken;
				this.pendingChangesToken = undefined;
			}
			// Only advance the watermark when the sync actually completed.
			// Advancing it after a partial/failed sync would hide any remote
			// change made during the failed run from the next pull.
			if (markSynced) {
				this.settings.lastSyncedAt = Date.now();
			}
			await this.saveSettings();
		} finally {
			this.pendingChangesToken = undefined;
			this.ribbonIcon?.removeClass("spin");
			this.syncing = false;
			syncNotice?.hide();
		}
	}

	async runInitialSync() {
		if (!(await checkConnection())) return;
		try {
			this.syncing = true;
			this.ribbonIcon?.addClass("spin");
			if ((await pull(this, true)) === false) {
				throw new Error("Unable to complete initial sync.");
			}
			await this.endSync();
		} catch (error) {
			this.pendingChangesToken = undefined;
			console.error("[Obsidian Gdrive Sync] Initial sync error:", error);
		} finally {
			this.syncing = false;
			this.ribbonIcon?.removeClass("spin");
		}
	}

	async disconnectDrive() {
		this.settings.refreshToken = "";
		this.settings.changesToken = "";
		this.settings.driveIdToPath = {};
		this.settings.renames = {};
		this.settings.operations = {};
		this.accessToken = { token: "", expiresAt: 0 };
		await this.saveSettings();
	}
}

class SettingsTab extends PluginSettingTab {
	plugin: ObsidianGoogleDrive;

	constructor(app: App, plugin: ObsidianGoogleDrive) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;
		const { vault } = this.app;

		containerEl.empty();

		const isConnected = !!this.plugin.settings.refreshToken;

		new Setting(containerEl)
			.setName("Google Drive connection")
			.setDesc(
				isConnected
					? "Your vault is connected to Google Drive."
					: "Connect your Google account to sync this vault with Google Drive.",
			)
			.addButton((button) => {
				if (isConnected) {
					button
						.setButtonText("Disconnect")
						.setWarning()
						.onClick(async () => {
							await this.plugin.disconnectDrive();
							new Notice("Disconnected from Google Drive.");
							this.display();
						});
					return;
				}

				button
					.setDisabled(
						!this.plugin.settings.clientId ||
							!this.plugin.settings.clientSecret,
					)
					.setButtonText("Connect to Google Drive")
					.setCta()
					.onClick(() => {
						if (
							!this.plugin.settings.clientId ||
							!this.plugin.settings.clientSecret
						) {
							new Notice(
								"Enter your Google OAuth client ID and secret first.",
							);
							return;
						}
						const existingFiles = vault
							.getAllLoadedFiles()
							.filter(({ path }) => path !== "/");

						if (existingFiles.length > 0) {
							new Notice(
								`Found ${existingFiles.length} existing file(s). These will be queued to upload to Google Drive on your first push.`,
							);
						}

						new DeviceAuthModal(
							this.app,
							this.plugin.getOAuthCredentials(),
							async (tokens) => {
								existingFiles.forEach((file) => {
									if (
										!this.plugin.settings.operations[
											file.path
										]
									) {
										this.plugin.settings.operations[
											file.path
										] = "create";
									}
								});

								this.plugin.settings.refreshToken =
									tokens.refresh_token;
								this.plugin.accessToken = {
									token: tokens.access_token,
									expiresAt:
										Date.now() + tokens.expires_in * 1000,
								};

								const changesToken =
									await this.plugin.drive.getChangesStartToken();
								if (changesToken) {
									this.plugin.settings.changesToken =
										changesToken;
								}

								await this.plugin.saveSettings();
								this.plugin.registerSyncFeatures();

								new Notice(
									"Connected to Google Drive! Starting initial sync…",
								);
								await this.plugin.runInitialSync();
								this.display();
							},
						).open();
					});
			});

		new Setting(containerEl)
			.setName("Google OAuth client ID")
			.setDesc("Client ID from your Google Cloud OAuth credentials.")
			.addText((text) =>
				text
					.setValue(this.plugin.settings.clientId)
					.setPlaceholder("Enter client ID")
					.onChange(async (value) => {
						this.plugin.settings.clientId = value.trim();
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl)
			.setName("Google OAuth client secret")
			.setDesc("Client secret from your Google Cloud OAuth credentials.")
			.addText((text) =>
				text
					.setValue(this.plugin.settings.clientSecret)
					.setPlaceholder("Enter client secret")
					.then((input) => {
						input.inputEl.type = "password";
					})
					.onChange(async (value) => {
						this.plugin.settings.clientSecret = value.trim();
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl)
			.setName("Sync on save")
			.setDesc(
				"Automatically sync changes to Google Drive in the background when files are modified.",
			)
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.syncOnSave)
					.onChange(async (value) => {
						this.plugin.settings.syncOnSave = value;
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl)
			.setName("Sync on save delay")
			.setDesc(
				"Seconds of typing inactivity to wait before triggering auto-sync.",
			)
			.addSlider((slider) =>
				slider
					.setLimits(1, 10, 1)
					.setValue(this.plugin.settings.syncOnSaveDelay || 2)
					.setDynamicTooltip()
					.onChange(async (value) => {
						this.plugin.settings.syncOnSaveDelay = value;
						this.plugin.updateSyncOnSaveDebounce();
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl)
			.setName("Ribbon button action")
			.setDesc(
				"Action when clicking the Google Drive icon on the left ribbon.",
			)
			.addDropdown((dropdown) =>
				dropdown
					.addOption(
						"sync",
						"Sync with Google Drive (Push of a button)",
					)
					.addOption("menu", "Open sync menu")
					.setValue(this.plugin.settings.ribbonAction || "sync")
					.onChange(async (value) => {
						if (value !== "sync" && value !== "menu") return;
						this.plugin.settings.ribbonAction = value;
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl)
			.setName("Confirm before push")
			.setDesc(
				"Prompt for confirmation before pushing local changes to Google Drive. (Disabled by default for seamless one-click and save syncing).",
			)
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.confirmPush)
					.onChange(async (value) => {
						this.plugin.settings.confirmPush = value;
						await this.plugin.saveSettings();
					}),
			);
	}
}
