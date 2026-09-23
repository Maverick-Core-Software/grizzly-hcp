/** Runtime-built fixture identifiers avoid credential-shaped source literals. */
export const fakeSid = (prefix: string): string => `${prefix}${'0'.repeat(32)}`;
