/** Runtime-built fixture values deliberately avoid credential-shaped literals. */
export const fakeSid = (prefix: string): string => `${prefix}${'0'.repeat(32)}`;
export const fakeHexToken = (): string => '0'.repeat(32);
export const fakeLiveKitKey = (): string => `API${'x'.repeat(10)}`;
export const fakeOpenAiKey = (): string => `sk-${'x'.repeat(20)}`;
