/**
 * Small cross-platform helpers.
 *
 * Obsidian mobile runs inside an embedded WebView that can be older than the
 * browser on a desktop machine, so these helpers avoid APIs that are missing
 * there.
 */

/**
 * Generate a v4 UUID.
 *
 * `crypto.randomUUID()` only exists in secure contexts and only on browsers
 * released after March 2022 (iOS Safari 15.4+, Chrome 92+), so it is missing on
 * some Obsidian mobile devices. Fall back to `crypto.getRandomValues()`, which
 * is available far more widely, and finally to `Math.random` for a WebView with
 * no Web Crypto at all.
 */
export const randomUUID = (): string => {
	const webCrypto = typeof crypto !== "undefined" ? crypto : undefined;

	if (typeof webCrypto?.randomUUID === "function") {
		return webCrypto.randomUUID();
	}

	if (typeof webCrypto?.getRandomValues === "function") {
		const bytes = webCrypto.getRandomValues(new Uint8Array(16));
		bytes[6] = (bytes[6] & 0x0f) | 0x40; // version 4
		bytes[8] = (bytes[8] & 0x3f) | 0x80; // variant 10
		const hex = Array.from(bytes, (byte) =>
			byte.toString(16).padStart(2, "0"),
		).join("");
		return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(
			12,
			16,
		)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
	}

	return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (char) => {
		const random = (Math.random() * 16) | 0;
		const value = char === "x" ? random : (random & 0x3) | 0x8;
		return value.toString(16);
	});
};

/**
 * Normalise a file modification time to milliseconds.
 *
 * Obsidian documents `Stat.mtime` and `DataWriteOptions.mtime` as milliseconds,
 * but some mobile filesystem implementations report whole seconds. Because the
 * sync compares local mtimes against Drive's millisecond timestamps, a
 * second-precision value would be mis-ordered, so normalise it here instead.
 */
export const toMilliseconds = (
	value: number | null | undefined,
): number | undefined => {
	if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
		return undefined;
	}
	// Current epoch milliseconds are ~1e12; anything below ~1e11 is seconds.
	return value < 1e11 ? Math.round(value * 1000) : value;
};
