// Mirrors bridge/src/codes.ts (index = refusal code number). Append only.
export const CODES = [
  'OK', 'BAD_BORSH', 'TRAILING_BYTES', 'MULTI_ACTION', 'NOT_FUNCTION_CALL',
  'WRONG_SIGNER', 'WRONG_KEY', 'WRONG_RECEIVER', 'METHOD_NOT_ALLOWED',
  'DEPOSIT_NOT_ZERO', 'GAS_TOO_HIGH', 'NONCE_REPLAY', 'BAD_ARGS',
  'RECEIVER_NOT_ALLOWED', 'TOKEN_NOT_ALLOWED', 'AMOUNT_OVER_CAP', 'VELOCITY_CAP',
  'BUTTON_TIMEOUT', 'REFUSAL_MISMATCH', 'CHAIN_DEST_NOT_ALLOWED', 'CHAIN_VALUE_OVER_CAP',
  'BAD_POLICY', 'TX_TOO_LARGE',
  'FW_MISMATCH', 'DECISION_REQUIRED', 'DECISION_INVALID', 'OWNER_SIG_INVALID', 'APPROVAL_NOT_ALLOWED',
] as const;
export type CodeName = (typeof CODES)[number];

/** Name for a numeric or string code. Unknown numbers are shown as `code N`, never guessed. */
export function codeName(c: string | number | undefined | null): string {
  if (c === undefined || c === null || c === '') return '';
  if (typeof c === 'number') return CODES[c] ?? `code ${c}`;
  if (/^\d+$/.test(c)) return CODES[Number(c)] ?? `code ${c}`;
  return c;
}
export const codeNum = (name: string): number => (CODES as readonly string[]).indexOf(name);
