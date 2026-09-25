import { App, Modal, Notice, Platform, Setting } from "obsidian";
import {
	requestDeviceCode,
	pollForToken,
	TokenResponse,
	OAuthCredentials,
} from "helpers/deviceAuth";

export class DeviceAuthModal extends Modal {
	private cancelled = false;
	private onSuccess: (tokens: TokenResponse) => void | Promise<void>;
	private credentials: OAuthCredentials;

	constructor(
		app: App,
		credentials: OAuthCredentials,
		onSuccess: (tokens: TokenResponse) => void | Promise<void>,
	) {
		super(app);
		this.credentials = credentials;
		this.onSuccess = onSuccess;
	}

	async onOpen() {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.createEl("h2", { text: "Connect to Google Drive" });

		const statusEl = contentEl.createEl("p", {
			text: "Requesting a login code from Google…",
		});

		let deviceCodeResponse;
		try {
			deviceCodeResponse = await requestDeviceCode(this.credentials);
		} catch (error) {
			statusEl.setText(
				"Failed to reach Google. Check your internet connection and try again.",
			);
			return;
		}

		if (this.cancelled) return;

		const {
			device_code,
			user_code,
			verification_url,
			verification_uri,
			interval,
			expires_in,
		} = deviceCodeResponse;
		// Google documents both `verification_url` and `verification_uri`;
		// accept whichever the API returns.
		const verificationUrl = verification_url || verification_uri || "";

		statusEl.setText("Enter this code at the link below:");

		const codeEl = contentEl.createEl("div", { text: user_code });
		codeEl.style.fontSize = "2em";
		codeEl.style.fontWeight = "bold";
		codeEl.style.letterSpacing = "0.1em";
		codeEl.style.textAlign = "center";
		codeEl.style.margin = "1em 0";
		codeEl.style.userSelect = "all";

		new Setting(contentEl).addButton((button) =>
			button
				.setButtonText("Open verification page")
				.setCta()
				.onClick(() => {
					// Obsidian mobile's WebView does not honour the `_blank`
					// target, so open without it there (the shell routes http(s)
					// links to the system browser).
					const opened = Platform.isMobileApp
						? window.open(verificationUrl)
						: window.open(verificationUrl, "_blank");
					if (!opened) {
						new Notice(
							`Open this link in your browser: ${verificationUrl}`,
							8000,
						);
					}
				}),
		);

		const linkEl = contentEl.createEl("p", {
			text: verificationUrl,
		});
		linkEl.style.userSelect = "all";
		linkEl.style.wordBreak = "break-all";

		const pollingStatusEl = contentEl.createEl("p", {
			text: "Waiting for you to approve access…",
		});

		try {
			const tokens = await pollForToken(
				device_code,
				interval,
				expires_in,
				this.credentials,
				() => !this.cancelled,
			);

			if (this.cancelled) return;

			await this.onSuccess(tokens);
			if (this.cancelled) return;
			pollingStatusEl.setText("Connected!");
			this.close();
		} catch (error) {
			if (this.cancelled) return;

			const message =
				error instanceof Error ? error.message : String(error);

			if (message === "access_denied") {
				pollingStatusEl.setText("Access was denied.");
			} else if (message === "expired_token") {
				pollingStatusEl.setText("Code expired. Please try again.");
			} else {
				pollingStatusEl.setText(`Something went wrong: ${message}`);
			}

			new Notice("Google Drive connection failed. See plugin settings.");
		}
	}

	onClose() {
		this.cancelled = true;
		this.contentEl.empty();
	}
}
