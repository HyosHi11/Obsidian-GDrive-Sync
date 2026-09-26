// drive.file is the ONLY broad Drive scope device flow supports (plus
// drive.appdata). It grants access to files this app creates, which is
// sufficient since the plugin owns its entire Drive-side file tree.
const SCOPE = "https://www.googleapis.com/auth/drive.file";

export interface OAuthCredentials {
	clientId: string;
	clientSecret: string;
}

export interface DeviceCodeResponse {
	device_code: string;
	user_code: string;
	verification_url: string;
	verification_uri?: string;
	expires_in: number; // seconds until device_code/user_code expire
	interval: number; // minimum seconds to wait between poll requests
}

export interface TokenResponse {
	access_token: string;
	refresh_token: string;
	expires_in: number; // seconds until access_token expires
	scope: string;
	token_type: string;
}

interface TokenErrorResponse {
	error: string;
	error_description?: string;
}

/**
 * Step 1: request a device code + user code from Google.
 * Throws if the request itself fails (network error, invalid client, etc).
 */
export async function requestDeviceCode(
	credentials: OAuthCredentials,
): Promise<DeviceCodeResponse> {
	const response = await fetch("https://oauth2.googleapis.com/device/code", {
		method: "POST",
		headers: { "Content-Type": "application/x-www-form-urlencoded" },
		body: new URLSearchParams({
			client_id: credentials.clientId,
			scope: SCOPE,
		}),
	});

	if (!response.ok) {
		throw new Error(`Failed to request device code: ${response.status}`);
	}

	return response.json();
}

/**
 * Step 2: poll Google until the user approves (or denies/expires).
 * Resolves with tokens on success, rejects with an Error on denial,
 * expiry, or any error other than "still waiting".
 */
export async function pollForToken(
	deviceCode: string,
	intervalSeconds: number,
	expiresInSeconds: number,
	credentials: OAuthCredentials,
	// called after every failed poll attempt so the caller can update UI / allow cancellation
	onPending?: () => boolean, // return false to stop polling early
): Promise<TokenResponse> {
	const deadline = Date.now() + expiresInSeconds * 1000;
	let currentInterval = intervalSeconds;

	while (Date.now() < deadline) {
		await sleep(currentInterval * 1000);

		const response = await fetch("https://oauth2.googleapis.com/token", {
			method: "POST",
			headers: { "Content-Type": "application/x-www-form-urlencoded" },
			body: new URLSearchParams({
				client_id: credentials.clientId,
				client_secret: credentials.clientSecret,
				device_code: deviceCode,
				grant_type: "urn:ietf:params:oauth:grant-type:device_code",
			}),
		});

		const data: TokenResponse | TokenErrorResponse = await response.json();

		if (response.ok) {
			return data as TokenResponse;
		}

		const error = (data as TokenErrorResponse).error;

		if (error === "authorization_pending") {
			if (onPending && onPending() === false) {
				throw new Error("cancelled");
			}
			continue;
		}

		if (error === "slow_down") {
			currentInterval += 5; // Google asked us to back off; widen the poll interval
			if (onPending && onPending() === false) {
				throw new Error("cancelled");
			}
			continue;
		}

		// access_denied, expired_token, or anything else is terminal
		throw new Error(error ?? "Unknown device auth error");
	}

	throw new Error("expired_token");
}

/**
 * Refresh an access token using a stored refresh token.
 * Replaces the plugin's old helpers/ky refreshAccessToken implementation.
 */
export async function refreshAccessTokenWithRefreshToken(
	refreshToken: string,
	credentials: OAuthCredentials,
): Promise<{ access_token: string; expires_in: number }> {
	const response = await fetch("https://oauth2.googleapis.com/token", {
		method: "POST",
		headers: { "Content-Type": "application/x-www-form-urlencoded" },
		body: new URLSearchParams({
			client_id: credentials.clientId,
			client_secret: credentials.clientSecret,
			refresh_token: refreshToken,
			grant_type: "refresh_token",
		}),
	});

	if (!response.ok) {
		// Surface Google's error code (e.g. invalid_grant when the token was
		// revoked) so the user is told why instead of just an HTTP status.
		let detail = "";
		try {
			const body = (await response.json()) as TokenErrorResponse;
			detail = [body.error, body.error_description]
				.filter(Boolean)
				.join(": ");
		} catch {
			// Not a JSON body; the status alone will have to do.
		}
		throw new Error(
			`Failed to refresh access token (HTTP ${response.status}${
				detail ? `, ${detail}` : ""
			})`,
		);
	}

	return response.json();
}

function sleep(ms: number) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}
