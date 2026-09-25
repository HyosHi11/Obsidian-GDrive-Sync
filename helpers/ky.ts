import ky, { Hooks } from "ky";
import ObsidianGoogleDrive from "main";

const getHooks = (t: ObsidianGoogleDrive): Hooks => ({
	beforeRequest: [
		async (request) => {
			if (
				!t.accessToken.token ||
				t.accessToken.expiresAt - Date.now() < 60000
			) {
				if (t.settings.refreshToken) {
					await t.refreshAccessToken();
				}
			}
			if (t.accessToken.token) {
				request.headers.set(
					"Authorization",
					`Bearer ${t.accessToken.token}`,
				);
			}
			return request;
		},
	],
	afterResponse: [
		async (request, options, response) => {
			if (response.status === 401 && t.settings.refreshToken) {
				const refreshed = await t.refreshAccessToken();
				if (refreshed && t.accessToken.token) {
					request.headers.set(
						"Authorization",
						`Bearer ${t.accessToken.token}`,
					);
					// Reuse the same generous timeout as the extended client;
					// the bare ky default (10s) is too short for uploads.
					return ky(request, { timeout: 120_000 });
				}
			}

			if (!response.ok) {
				console.error(
					`[Obsidian Gdrive Sync] HTTP ${response.status} on ${request.url}:`,
					await response.clone().text(),
				);
			}
			return response;
		},
	],
});

export const getDriveKy = (t: ObsidianGoogleDrive) => {
	return ky.extend({
		prefixUrl: "https://www.googleapis.com",
		hooks: getHooks(t),
		timeout: 120_000,
	});
};
