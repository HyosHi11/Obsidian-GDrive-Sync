import ObsidianGoogleDrive from "main";
import { getDriveKy } from "./ky";
import { TAbstractFile, TFolder } from "obsidian";

export interface FileMetadata {
	id: string;
	name: string;
	description: string;
	mimeType: string;
	starred: boolean;
	properties: Record<string, string>;
	modifiedTime: string;
	parents?: string[];
}

interface DriveIdResponse {
	id: string;
}

interface DriveFilesResponse {
	nextPageToken?: string;
	files: FileMetadata[];
}

interface DriveStartPageTokenResponse {
	startPageToken: string;
}

interface DriveChange {
	kind?: string;
	changeType?: string;
	removed: boolean;
	file?: FileMetadata & { trashed?: boolean };
	fileId: string;
	time: string;
}

interface DriveChangesResponse {
	nextPageToken?: string;
	newStartPageToken?: string;
	changes?: DriveChange[];
}

const getErrorStatus = (error: unknown): number | undefined => {
	if (typeof error !== "object" || error === null || !("response" in error)) {
		return;
	}
	const response = error.response;
	if (
		typeof response !== "object" ||
		response === null ||
		!("status" in response)
	) {
		return;
	}
	return typeof response.status === "number" ? response.status : undefined;
};

type StringSearch = string | { contains: string } | { not: string };
type DateComparison = { eq: string } | { gt: string } | { lt: string };

interface QueryMatch {
	name?: StringSearch | StringSearch[];
	mimeType?: StringSearch | StringSearch[];
	parent?: string;
	starred?: boolean;
	query?: string;
	properties?: Record<string, string>;
	modifiedTime?: DateComparison;
}

export const folderMimeType = "application/vnd.google-apps.folder";

const BLACKLISTED_CONFIG_FILES = [
	"graph.json",
	"workspace.json",
	"workspace-mobile.json",
];

const WHITELISTED_PLUGIN_FILES = [
	"manifest.json",
	"styles.css",
	"main.js",
	"data.json",
];
const escapeQuery = (str: string) =>
	str.replace(/\\/g, "\\\\").replace(/'/g, "\\'");

const stringSearchToQuery = (search: StringSearch) => {
	if (typeof search === "string") return `='${escapeQuery(search)}'`;
	if ("contains" in search)
		return ` contains '${escapeQuery(search.contains)}'`;
	if ("not" in search) return `!='${escapeQuery(search.not)}'`;
};

const queryHandlers = {
	name: (name: StringSearch) => "name" + stringSearchToQuery(name),
	mimeType: (mimeType: StringSearch) =>
		"mimeType" + stringSearchToQuery(mimeType),
	parent: (parent: string) => `'${escapeQuery(parent)}' in parents`,
	starred: (starred: boolean) => `starred=${starred}`,
	query: (query: string) => `fullText contains '${escapeQuery(query)}'`,
	properties: (properties: Record<string, string>) =>
		Object.entries(properties)
			.map(
				([key, value]) =>
					`properties has { key='${escapeQuery(key)}' and value='${escapeQuery(value)}' }`,
			)
			.join(" and "),
	modifiedTime: (modifiedTime: DateComparison) => {
		if ("eq" in modifiedTime) return `modifiedTime='${modifiedTime.eq}'`;
		if ("gt" in modifiedTime) return `modifiedTime>'${modifiedTime.gt}'`;
		if ("lt" in modifiedTime) return `modifiedTime<'${modifiedTime.lt}'`;
	},
};

export const fileListToMap = (files: { id: string; name: string }[]) =>
	Object.fromEntries(files.map(({ id, name }) => [name, id]));

export const getDriveClient = (t: ObsidianGoogleDrive) => {
	const drive = getDriveKy(t);

	const getQuery = (matches?: QueryMatch[]) => {
		const vaultId = escapeQuery(t.settings.vaultId);
		const vaultClause = `trashed=false and properties has { key='vaultId' and value='${vaultId}' }`;
		if (!matches || matches.length === 0) {
			return encodeURIComponent(vaultClause);
		}

		const matchClauses = matches
			.map((match) => {
				const entries = Object.entries(match).flatMap(([key, value]) =>
					value === undefined
						? []
						: Array.isArray(value)
							? value.map((v) => [key, v])
							: [[key, value]],
				);
				if (!entries.length) return "";
				return `(${entries
					.map(([key, value]) =>
						queryHandlers[key as keyof QueryMatch](value as never),
					)
					.join(" and ")})`;
			})
			.filter(Boolean);

		if (!matchClauses.length) {
			return encodeURIComponent(vaultClause);
		}

		return encodeURIComponent(
			`(${matchClauses.join(" or ")}) and ${vaultClause}`,
		);
	};

	const paginateFiles = async ({
		matches,
		pageToken,
		order = "descending",
		pageSize = 30,
		include = [
			"id",
			"name",
			"mimeType",
			"starred",
			"description",
			"properties",
		],
	}: {
		matches?: QueryMatch[];
		order?: "ascending" | "descending";
		pageToken?: string;
		pageSize?: number;
		include?: (keyof FileMetadata)[];
	}) => {
		const files = await drive
			.get(
				`drive/v3/files?fields=nextPageToken,files(${include.join(
					",",
				)})&pageSize=${pageSize}&q=${getQuery(matches)}${
					matches?.find(({ query }) => query)
						? ""
						: "&orderBy=name" +
							(order === "ascending" ? "" : " desc")
				}${pageToken ? "&pageToken=" + pageToken : ""}`,
			)
			.json<DriveFilesResponse>();
		if (!files) return;
		return files;
	};

	const searchFiles = async (
		data: {
			matches?: QueryMatch[];
			order?: "ascending" | "descending";
			include?: (keyof FileMetadata)[];
		},
		includeObsidian = false,
	) => {
		const files = await paginateFiles({ ...data, pageSize: 1000 });
		if (!files) return;

		while (files.nextPageToken) {
			const nextPage = await paginateFiles({
				...data,
				pageToken: files.nextPageToken,
				pageSize: 1000,
			});
			if (!nextPage) return;
			files.files.push(...nextPage.files);
			files.nextPageToken = nextPage.nextPageToken;
		}

		if (includeObsidian) return files.files as FileMetadata[];

		return files.files.filter(
			({ properties }) => properties?.obsidian !== "vault",
		) as FileMetadata[];
	};

	const getRootFolderId = async () => {
		const files = await searchFiles(
			{
				matches: [{ properties: { obsidian: "vault" } }],
			},
			true,
		);
		if (!files) return;
		if (!files.length) {
			const rootFolder = await drive
				.post(`drive/v3/files`, {
					json: {
						name: t.app.vault.getName(),
						mimeType: folderMimeType,
						description: "Obsidian Vault: " + t.app.vault.getName(),
						properties: {
							obsidian: "vault",
							vault: t.app.vault.getName(),
							vaultId: t.settings.vaultId,
						},
					},
				})
				.json<DriveIdResponse>();
			if (!rootFolder) return;
			return rootFolder.id as string;
		} else {
			return files[0].id as string;
		}
	};

	const createFolder = async ({
		name,
		parent,
		description,
		properties,
		modifiedTime,
	}: {
		name: string;
		description?: string;
		parent?: string;
		properties?: Record<string, string>;
		modifiedTime?: string;
	}) => {
		if (!parent) {
			parent = await getRootFolderId();
			if (!parent) return;
		}

		if (!properties) properties = {};
		if (!properties.vault) properties.vault = t.app.vault.getName();
		properties.vaultId = t.settings.vaultId;

		const folder = await drive
			.post(`drive/v3/files`, {
				json: {
					name,
					mimeType: folderMimeType,
					description,
					parents: [parent],
					properties,
					modifiedTime,
				},
			})
			.json<DriveIdResponse>();
		if (!folder) return;
		return folder.id as string;
	};

	const getMimeType = (filename: string): string => {
		const ext = filename.split(".").pop()?.toLowerCase();
		switch (ext) {
			case "md":
				return "text/markdown";
			case "txt":
				return "text/plain";
			case "json":
				return "application/json";
			case "png":
				return "image/png";
			case "jpg":
			case "jpeg":
				return "image/jpeg";
			case "gif":
				return "image/gif";
			case "svg":
				return "image/svg+xml";
			case "pdf":
				return "application/pdf";
			case "css":
				return "text/css";
			case "js":
				return "application/javascript";
			default:
				return "application/octet-stream";
		}
	};

	const uploadFile = async (
		file: Blob,
		name: string,
		parent?: string,
		metadata?: Partial<Omit<FileMetadata, "id">>,
	) => {
		if (!parent) {
			parent = await getRootFolderId();
			if (!parent) {
				console.error(
					"[Obsidian Gdrive Sync] Could not determine parent folder for upload.",
				);
				return;
			}
		}

		if (!metadata) metadata = {};
		if (!metadata.properties) metadata.properties = {};
		if (!metadata.properties.vault) {
			metadata.properties.vault = t.app.vault.getName();
		}
		metadata.properties.vaultId = t.settings.vaultId;

		const mimeType = file.type || getMimeType(name);
		const boundary =
			"-------ObsidianGDrive" + Math.random().toString(36).substring(2);
		const delimiter = `\r\n--${boundary}\r\n`;
		const closeDelimiter = `\r\n--${boundary}--`;

		const metadataPayload = {
			name,
			mimeType,
			parents: [parent],
			...metadata,
		};

		const multipartBody = new Blob(
			[
				delimiter,
				"Content-Type: application/json; charset=UTF-8\r\n\r\n",
				JSON.stringify(metadataPayload),
				delimiter,
				`Content-Type: ${mimeType}\r\n\r\n`,
				file,
				closeDelimiter,
			],
			{ type: `multipart/related; boundary=${boundary}` },
		);

		const result = await drive
			.post(`upload/drive/v3/files?uploadType=multipart&fields=id`, {
				body: multipartBody,
				headers: {
					"Content-Type": `multipart/related; boundary=${boundary}`,
				},
			})
			.json<DriveIdResponse>();
		if (!result) return;

		return result.id as string;
	};

	const updateFile = async (
		id: string,
		newContent: Blob,
		newMetadata: Partial<Omit<FileMetadata, "id">> = {},
		params?: { addParents?: string; removeParents?: string },
	) => {
		if (!id) {
			throw new Error("Cannot update a Google Drive file without an ID.");
		}

		if (!newMetadata.properties) newMetadata.properties = {};
		if (!newMetadata.properties.vault) {
			newMetadata.properties.vault = t.app.vault.getName();
		}
		// Keep this consistent with createFolder/uploadFile/updateFileMetadata:
		// without it the updated file would fall out of the vaultId-scoped queries.
		newMetadata.properties.vaultId = t.settings.vaultId;

		const mimeType = newContent.type || "text/markdown";
		const boundary =
			"-------ObsidianGDrive" + Math.random().toString(36).substring(2);
		const delimiter = `\r\n--${boundary}\r\n`;
		const closeDelimiter = `\r\n--${boundary}--`;

		const multipartBody = new Blob(
			[
				delimiter,
				"Content-Type: application/json; charset=UTF-8\r\n\r\n",
				JSON.stringify(newMetadata),
				delimiter,
				`Content-Type: ${mimeType}\r\n\r\n`,
				newContent,
				closeDelimiter,
			],
			{ type: `multipart/related; boundary=${boundary}` },
		);

		const searchParams = new URLSearchParams({
			uploadType: "multipart",
			fields: "id",
		});
		if (params?.addParents)
			searchParams.set("addParents", params.addParents);
		if (params?.removeParents)
			searchParams.set("removeParents", params.removeParents);

		const result = await drive
			.patch(`upload/drive/v3/files/${id}?${searchParams.toString()}`, {
				body: multipartBody,
				headers: {
					"Content-Type": `multipart/related; boundary=${boundary}`,
				},
			})
			.json<DriveIdResponse>();
		if (!result) return;

		return result.id as string;
	};

	const updateFileMetadata = async (
		id: string,
		metadata: Partial<Omit<FileMetadata, "id">>,
		params?: { addParents?: string; removeParents?: string },
	) => {
		if (!metadata.properties) metadata.properties = {};
		if (!metadata.properties.vault) {
			metadata.properties.vault = t.app.vault.getName();
		}
		metadata.properties.vaultId = t.settings.vaultId;

		const searchParams = new URLSearchParams();
		if (params?.addParents)
			searchParams.set("addParents", params.addParents);
		if (params?.removeParents)
			searchParams.set("removeParents", params.removeParents);
		const qs = searchParams.toString() ? `?${searchParams.toString()}` : "";

		const result = await drive
			.patch(`drive/v3/files/${id}${qs}`, {
				json: metadata,
			})
			.json<DriveIdResponse>();
		if (!result) return;
		return result.id as string;
	};

	// Lists files matching a raw Drive query string, bypassing the automatic
	// vaultId scoping applied by getQuery(). Only used by the legacy-tree
	// migration below, which needs to find files that predate vaultId tagging.
	const listFilesByRawQuery = async (rawQuery: string) => {
		const files: FileMetadata[] = [];
		let pageToken: string | undefined;
		do {
			const page = await drive
				.get(
					`drive/v3/files?fields=nextPageToken,files(id,name,mimeType,properties)&pageSize=1000&q=${encodeURIComponent(
						rawQuery,
					)}${pageToken ? `&pageToken=${pageToken}` : ""}`,
				)
				.json<DriveFilesResponse>();
			if (!page) return;
			files.push(...(page.files || []));
			pageToken = page.nextPageToken;
		} while (pageToken);
		return { files };
	};

	/**
	 * One-time migration for vaults whose Drive tree was created before
	 * `vaultId` scoping existed. Those files are only tagged with
	 * `properties.vault` (the vault name), so without this they are invisible
	 * to searchFiles() and the plugin would silently create a duplicate tree.
	 */
	const ensureVaultMigrated = async () => {
		if (t.settings.vaultIdMigrated) return true;

		// If a vaultId-scoped root already exists there is nothing to do.
		const scopedRoot = await searchFiles(
			{ matches: [{ properties: { obsidian: "vault" } }] },
			true,
		);
		if (!scopedRoot) return false;
		if (scopedRoot.length) {
			t.settings.vaultIdMigrated = true;
			await t.saveSettings();
			return true;
		}

		const vaultName = escapeQuery(t.app.vault.getName());
		const legacyRoot = await listFilesByRawQuery(
			`trashed=false and mimeType='${folderMimeType}' and properties has { key='obsidian' and value='vault' } and properties has { key='vault' and value='${vaultName}' }`,
		);
		if (!legacyRoot) return false;
		if (!legacyRoot.files.length) {
			// No pre-existing tree for this vault name; there is nothing to
			// adopt, so do not stamp unrelated Drive files.
			t.settings.vaultIdMigrated = true;
			await t.saveSettings();
			return true;
		}

		// No vaultId-scoped tree exists yet, so every file carrying this vault
		// name belongs to the legacy tree and can safely be stamped.
		const legacyFiles = await listFilesByRawQuery(
			`trashed=false and properties has { key='vault' and value='${vaultName}' }`,
		);
		if (!legacyFiles) return false;

		const idsToMigrate = new Set<string>();
		(legacyRoot.files || []).forEach(({ id }) => idsToMigrate.add(id));
		legacyFiles.files.forEach(({ id }) => idsToMigrate.add(id));

		if (idsToMigrate.size) {
			const results = await batchAsyncs(
				Array.from(idsToMigrate).map((id) => async () =>
					updateFileMetadata(id, {}),
				),
			);
			if (results.some((result) => !result)) return false;
		}

		t.settings.vaultIdMigrated = true;
		await t.saveSettings();
		return true;
	};

	const deleteFile = async (id: string) => {
		try {
			const result = await drive.delete(`drive/v3/files/${id}`);
			return result.ok;
		} catch (err) {
			if (getErrorStatus(err) === 404) return true;
			return false;
		}
	};

	const getFile = (id: string) =>
		drive.get(`drive/v3/files/${id}?alt=media&acknowledgeAbuse=true`);

	// getFile() returns ky's raw response object so callers can chain
	// .arrayBuffer()/.text()/etc directly. That means it can't go through
	// the generic error-catching wrapper below (it would resolve to a
	// Promise instead of a chainable response). Use this instead of
	// `getFile(id).arrayBuffer()` wherever you need the file's bytes and
	// want failures to resolve to `undefined` rather than throw.
	const getFileContent = async (id: string) => {
		try {
			return await getFile(id).arrayBuffer();
		} catch {
			return undefined;
		}
	};

	const getFileMetadata = (id: string) =>
		drive
			.get(
				`drive/v3/files/${id}?fields=id,name,mimeType,starred,description,properties,modifiedTime,parents`,
			)
			.json<FileMetadata>();

	const idFromPath = async (path: string) => {
		const files = await searchFiles({
			matches: [{ properties: { path } }],
		});
		if (!files?.length) return;
		return files[0].id as string;
	};

	const idsFromPaths = async (paths: string[]) => {
		const files = await searchFiles({
			matches: paths.map((path) => ({ properties: { path } })),
		});
		if (!files) return;
		return files.map((file) => ({
			id: file.id,
			path: file.properties.path,
		}));
	};

	const batchDelete = async (ids: string[]) => {
		if (!ids.length) return {};
		const results: Record<string, boolean> = {};
		await batchAsyncs(
			ids.map((id) => async () => {
				try {
					const response = await drive.delete(`drive/v3/files/${id}`);
					results[id] = response.ok;
				} catch (err) {
					results[id] = getErrorStatus(err) === 404;
					if (!results[id]) {
						console.error(
							`[Obsidian Gdrive Sync] Failed to delete file ${id}:`,
							err,
						);
					}
				}
			}),
			10,
		);
		return results;
	};

	const getChangesStartToken = async () => {
		const result = await drive
			.get(`drive/v3/changes/startPageToken`)
			.json<DriveStartPageTokenResponse>();
		if (!result) return;
		return result.startPageToken as string;
	};

	const getChanges = async (startToken: string) => {
		if (!startToken) {
			const initialToken = await getChangesStartToken();
			if (!initialToken) return;
			return {
				changes: [] as {
					kind?: string;
					removed: boolean;
					file?: FileMetadata & { trashed?: boolean };
					fileId: string;
					time: string;
				}[],
				newStartPageToken: initialToken,
				tokenRenewed: true,
			};
		}

		const request = (token: string) =>
			drive
				.get(
					`drive/v3/changes?${new URLSearchParams({
						pageToken: token,
						pageSize: "1000",
						includeRemoved: "true",
						supportsAllDrives: "true",
						includeItemsFromAllDrives: "true",
						fields: "nextPageToken,newStartPageToken,changes(changeType,fileId,removed,time,file(id,name,trashed,properties,mimeType))",
					}).toString()}`,
				)
				.json<DriveChangesResponse>();

		let result: DriveChangesResponse;
		try {
			result = await request(startToken);
		} catch (err) {
			const status = getErrorStatus(err);
			// Only a genuinely invalid/expired page token should silently
			// restart the changes feed. Network errors, 5xx responses and auth
			// failures must surface, otherwise the feed advances past changes
			// that were never seen and they are lost forever.
			if (status !== 400 && status !== 404 && status !== 410) {
				throw err;
			}
			console.warn(
				"[Obsidian Gdrive Sync] Changes token expired or invalid, renewing start token...",
				err,
			);
			const newToken = await getChangesStartToken();
			if (!newToken) return;
			return {
				changes: [] as {
					kind?: string;
					removed: boolean;
					file?: FileMetadata & { trashed?: boolean };
					fileId: string;
					time: string;
				}[],
				newStartPageToken: newToken,
				tokenRenewed: true,
			};
		}

		if (!result) return;
		const changes = [...(result.changes || [])];
		let newStartPageToken = result.newStartPageToken;

		while (result.nextPageToken) {
			const nextPage = await request(result.nextPageToken);
			if (!nextPage) {
				throw new Error(
					"Failed to fetch the next Google Drive changes page.",
				);
			}
			changes.push(...(nextPage.changes || []));
			newStartPageToken = nextPage.newStartPageToken;
			result = nextPage;
		}

		return {
			changes: changes as {
				kind?: string;
				removed: boolean;
				file?: FileMetadata & { trashed?: boolean };
				fileId: string;
				time: string;
			}[],
			newStartPageToken: (newStartPageToken || result.nextPageToken) as
				| string
				| undefined,
			tokenRenewed: false,
		};
	};

	const deleteFilesMinimumOperations = async (files: TAbstractFile[]) => {
		const results: Record<string, boolean> = {};
		const folders = files.filter(
			(file) => file instanceof TFolder,
		) as TFolder[];

		if (folders.length) {
			const maxDepth = Math.max(
				...folders.map(({ path }) => path.split("/").length),
			);

			for (let depth = 1; depth <= maxDepth; depth++) {
				const foldersToDelete = files.filter(
					(file) =>
						file instanceof TFolder &&
						file.path.split("/").length === depth,
				);
				const folderResults = await Promise.all(
					foldersToDelete.map(
						async (folder) =>
							[folder, await t.deleteFile(folder)] as const,
					),
				);
				folderResults.forEach(([folder, result]) => {
					results[folder.path] = result;
				});
				foldersToDelete.forEach(
					(folder) =>
						(files = files.filter(
							({ path }) =>
								!path.startsWith(folder.path + "/") &&
								path !== folder.path,
						)),
				);
			}
		}

		const fileResults = await Promise.all(
			files.map(
				async (file) => [file, await t.deleteFile(file)] as const,
			),
		);
		fileResults.forEach(([file, result]) => {
			results[file.path] = result;
		});
		return results;
	};

	const getConfigFilesToSync = async () => {
		const configFilesToSync: string[] = [];
		const { vault } = t.app;
		const { adapter } = vault;

		const [configFiles, plugins] = await Promise.all([
			adapter.list(vault.configDir),
			adapter.list(vault.configDir + "/plugins"),
		]);

		await Promise.all(
			configFiles.files
				.filter(
					(path) =>
						!BLACKLISTED_CONFIG_FILES.includes(
							fileNameFromPath(path),
						),
				)
				.map(async (path) => {
					const file = await adapter.stat(path);
					if ((file?.mtime || 0) > t.settings.lastSyncedAt) {
						configFilesToSync.push(path);
					}
				})
				.concat(
					plugins.folders.map(async (plugin) => {
						const files = await adapter.list(plugin);
						await Promise.all(
							files.files
								.filter((path) =>
									WHITELISTED_PLUGIN_FILES.includes(
										fileNameFromPath(path),
									),
								)
								.map(async (path) => {
									const file = await adapter.stat(path);
									if (
										(file?.mtime || 0) >
										t.settings.lastSyncedAt
									) {
										configFilesToSync.push(path);
									}
								}),
						);
					}),
				),
		);

		return configFilesToSync;
	};

	// The ky hook in ./ky shows a Notice on any failed request, but ky
	// still throws an HTTPError for that request (this is ky's default
	// behavior, and is what lets us tell success from failure). Every
	// caller of this client was written assuming a failed call just
	// resolves to `undefined` (`if (!result) return`), so wrap each method
	// here to catch that throw and preserve that contract in one place,
	// instead of adding try/catch at every call site in pull/push/reset.
	// getFile is intentionally excluded: it returns ky's raw chainable
	// response object rather than a resolved value, so wrapping it here
	// would break the `.arrayBuffer()`/`.text()` chaining callers rely on.
	// Use getFileContent for a safe, non-throwing way to read file bytes.
	const withErrorHandling = <Args extends unknown[], Result>(
		fn: (...args: Args) => Promise<Result>,
	) => {
		return async (...args: Args): Promise<Result | undefined> => {
			try {
				return await fn(...args);
			} catch {
				return undefined;
			}
		};
	};

	return {
		paginateFiles: withErrorHandling(paginateFiles),
		searchFiles: withErrorHandling(searchFiles),
		getRootFolderId: withErrorHandling(getRootFolderId),
		createFolder: withErrorHandling(createFolder),
		uploadFile: withErrorHandling(uploadFile),
		updateFile: withErrorHandling(updateFile),
		updateFileMetadata: withErrorHandling(updateFileMetadata),
		deleteFile: withErrorHandling(deleteFile),
		getFile,
		getFileContent,
		getFileMetadata: withErrorHandling(getFileMetadata),
		idFromPath: withErrorHandling(idFromPath),
		idsFromPaths: withErrorHandling(idsFromPaths),
		getChangesStartToken: withErrorHandling(getChangesStartToken),
		getChanges: withErrorHandling(getChanges),
		batchDelete: withErrorHandling(batchDelete),
		checkConnection,
		deleteFilesMinimumOperations: withErrorHandling(
			deleteFilesMinimumOperations,
		),
		getConfigFilesToSync: withErrorHandling(getConfigFilesToSync),
		ensureVaultMigrated: withErrorHandling(ensureVaultMigrated),
	};
};

export const checkConnection = async () => {
	if (typeof navigator !== "undefined" && !navigator.onLine) {
		return false;
	}
	try {
		const result = await fetch(
			"https://www.googleapis.com/discovery/v1/apis/drive/v3/rest",
			{ method: "HEAD", cache: "no-store" },
		);
		return result.ok;
	} catch {
		try {
			await fetch("https://www.google.com/generate_204", {
				mode: "no-cors",
				cache: "no-store",
			});
			return true;
		} catch {
			return false;
		}
	}
};

export const batchAsyncs = async <T>(
	requests: (() => Promise<T>)[],
	batchSize = 10,
): Promise<T[]> => {
	const results: T[] = [];
	for (let i = 0; i < requests.length; i += batchSize) {
		const batch = requests.slice(i, i + batchSize);
		results.push(...(await Promise.all(batch.map((request) => request()))));
	}
	return results;
};

export const getSyncMessage = (
	min: number,
	max: number,
	completed: number,
	total: number,
) => `Syncing (${Math.floor(min + (max - min) * (completed / total))}%)`;

export const fileNameFromPath = (path: string) => path.split("/").slice(-1)[0];

/**
 * @returns Batches in increasing order of depth
 */
export function foldersToBatches(folders: string[]): string[][];
export function foldersToBatches(folders: TFolder[]): TFolder[][];
export function foldersToBatches<T extends string | TFolder>(
	folders: T[],
): T[][] {
	if (!folders || folders.length === 0) return [];

	const getPath = (folder: T) =>
		(folder instanceof TFolder ? folder.path : folder) as string;
	const depths = folders.map((folder) => getPath(folder).split("/").length);
	const maxDepth = Math.max(...depths);
	if (maxDepth <= 0 || !isFinite(maxDepth)) return [];

	const batches: T[][] = new Array(maxDepth).fill(0).map(() => []);

	folders.forEach((folder) => {
		const depth = getPath(folder).split("/").length;
		batches[depth - 1].push(folder);
	});

	return batches;
}
