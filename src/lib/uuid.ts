/** Generate a UUID in browsers that do not expose crypto.randomUUID. */
export function createUUID(): string {
	const cryptoApi = globalThis.crypto;
	if (typeof cryptoApi?.randomUUID === 'function') return cryptoApi.randomUUID();
	if (typeof cryptoApi?.getRandomValues === 'function') {
		const bytes = new Uint8Array(16);
		cryptoApi.getRandomValues(bytes);
		bytes[6] = (bytes[6] & 0x0f) | 0x40;
		bytes[8] = (bytes[8] & 0x3f) | 0x80;
		const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
		return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
	}
	return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (char) => {
		const random = Math.random() * 16 | 0;
		return (char === 'x' ? random : (random & 0x3) | 0x8).toString(16);
	});
}
