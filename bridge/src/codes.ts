// Mirrors firmware/lib/fusecore/codes.h. Keep in sync.
export const CODES = [
  'OK', 'BAD_BORSH', 'TRAILING_BYTES', 'MULTI_ACTION', 'NOT_FUNCTION_CALL',
  'WRONG_SIGNER', 'WRONG_KEY', 'WRONG_RECEIVER', 'METHOD_NOT_ALLOWED',
  'DEPOSIT_NOT_ZERO', 'GAS_TOO_HIGH', 'NONCE_REPLAY', 'BAD_ARGS',
  'RECEIVER_NOT_ALLOWED', 'TOKEN_NOT_ALLOWED', 'AMOUNT_OVER_CAP', 'VELOCITY_CAP',
  'BUTTON_TIMEOUT', 'REFUSAL_MISMATCH', 'CHAIN_DEST_NOT_ALLOWED', 'CHAIN_VALUE_OVER_CAP',
  'BAD_POLICY', 'TX_TOO_LARGE',
] as const;
export type CodeName = (typeof CODES)[number];
export const codeNum = (name: CodeName) => CODES.indexOf(name);
export const codeName = (n: number): CodeName => (CODES[n] ?? 'BAD_BORSH');
