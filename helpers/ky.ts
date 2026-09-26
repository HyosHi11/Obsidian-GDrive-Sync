import ky, { Hooks } from "ky";
import ObsidianGoogleDrive from "main";

// Google's guidance for the Drive API is to retry 5xx and rate-limit responses
// with exponential backoff. ky's defaults only retry idempotent methods, so
// the POST/PATCH uploads were never retried, and they never retry 403, which
// is the status Drive uses for `userRateLimitExceeded`: one burst of ten
// concurrent uploads could fail outright and be reported as a failed sync.
const RETRY_OPTIONS = {
	limit: 3,
	methods: ["get", "post", "put", "patch", "head", "delete"],
	statusCodes: [403, 408, 429, 500, 502, 503, 504],
	// 0.5s, 1s, 2s between attempts. A `Retry-After` header is honoured up to
	// `backoffLimit`.
	delay: (attemptCount: number) => 500 * 2 ** (attemptCount - 1),
	backoffLimit: 8_000,
};

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
					return ky(request, {
						timeout: 120_000,
						retry: RETRY_OPTIONS,
					});
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
		retry: RETRY_OPTIONS,
	});
};
