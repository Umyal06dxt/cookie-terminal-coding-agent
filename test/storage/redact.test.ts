import { describe, expect, test } from 'bun:test';
import { REDACTED, redact, redactDeep } from '../../src/storage/redact.ts';

describe('redact', () => {
  test.each([
    [
      'sk-proj-Abc123def456GHI789jkl012',
      'key: sk-proj-Abc123def456GHI789jkl012 end',
    ],
    ['sk-ant-api03-aaaabbbbccccddddeeee', 'sk-ant-api03-aaaabbbbccccddddeeee'],
    ['user_9f8e7d6c5b4a39281706', 'COMMANDCODE key user_9f8e7d6c5b4a39281706'],
    ['ghp_0123456789abcdefABCDEF0123', 'token ghp_0123456789abcdefABCDEF0123'],
    ['AKIAIOSFODNN7EXAMPLE', 'aws AKIAIOSFODNN7EXAMPLE'],
    ['f'.repeat(64), `sha256 ${'f'.repeat(64)}`],
    [
      'dGhpc0lzQVNlY3JldEtleVdpdGhOdW1iZXJzMTIzNDU2',
      'b64 dGhpc0lzQVNlY3JldEtleVdpdGhOdW1iZXJzMTIzNDU2',
    ],
  ])('removes %s', (secret, text) => {
    const out = redact(text);
    expect(out).not.toContain(secret);
    expect(out).toContain(REDACTED);
  });

  test('keeps the name of an assigned secret, drops the value', () => {
    expect(redact('COMMANDCODE_API_KEY=abcd1234efgh5678')).toBe(
      `COMMANDCODE_API_KEY=${REDACTED}`,
    );
    expect(redact('{"api_key": "hunter2hunter2"}')).toBe(
      `{"api_key": "${REDACTED}"}`,
    );
    expect(redact('Authorization: Bearer abcdefghijklmnop1234')).toBe(
      `Authorization: Bearer ${REDACTED}`,
    );
  });

  test('leaves ordinary code alone', () => {
    for (const text of [
      'commit 3c3c7ea1f2b4c5d6e7f8091a2b3c4d5e6f708192', // a 40-char git SHA
      'src/agent/prompts/system.ts and node_modules/@types/react/index.d.ts',
      'const SESSION_TOKEN_LIMIT = 4000; // token counting',
      'export function renderTranscriptWithAVeryLongDescriptiveName() {}',
      'uuid 123e4567-e89b-12d3-a456-426614174000',
      'sk-short',
    ]) {
      expect(redact(text)).toBe(text);
    }
  });

  test('redactDeep scrubs every string in nested data, never keys', () => {
    const value = {
      sk_field: 'safe',
      nested: [{ content: 'use sk-abcdefghijklmnop1234 here' }, 7, null],
    };
    expect(redactDeep(value)).toEqual({
      sk_field: 'safe',
      nested: [{ content: `use ${REDACTED} here` }, 7, null],
    });
  });
});
