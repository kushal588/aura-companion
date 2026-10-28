import { describe, expect, it } from 'vitest';
import { DEFAULT_ARCHIVE_LIMITS, resolveSafeEntryPath, validateArchive } from '../src/utils/archive';
import { redactError, redactForDiagnostics, redactSecrets } from '../src/utils/redact';
import { isRetryableError, toProviderError, describeProviderError } from '../src/utils/retry';

describe('archive validation', () => {
  it('accepts a clean character bundle', () => {
    const result = validateArchive([
      { name: 'manifest.json', uncompressedSize: 500, compressedSize: 200 },
      { name: 'prompt.md', uncompressedSize: 300, compressedSize: 150 },
      { name: 'avatar.vrm', uncompressedSize: 20_000_000, compressedSize: 8_000_000 },
      { name: 'animations/idle.vrma', uncompressedSize: 100_000, compressedSize: 40_000 },
    ]);
    expect(result.ok).toBe(true);
    expect(result.issues).toHaveLength(0);
    expect(result.entries).toContain('avatar.vrm');
  });

  it('rejects path traversal and absolute paths', () => {
    const traversal = validateArchive([{ name: '../../etc/passwd', uncompressedSize: 10 }]);
    expect(traversal.ok).toBe(false);
    expect(traversal.issues[0]?.code).toBe('path_traversal');

    const absolute = validateArchive([{ name: '/root/.ssh/id_rsa', uncompressedSize: 10 }]);
    expect(absolute.issues[0]?.code).toBe('absolute_path');

    const windows = validateArchive([{ name: 'C:\\Windows\\System32\\evil.dll', uncompressedSize: 10 }]);
    expect(windows.ok).toBe(false);
  });

  it('rejects symlinks, nested archives and executables', () => {
    const symlink = validateArchive([
      // 0o120777 << 16 → symlink mode bits
      { name: 'link.vrm', uncompressedSize: 10, externalAttributes: 0o120777 << 16 },
    ]);
    expect(symlink.issues.some((issue) => issue.code === 'symlink')).toBe(true);

    const nested = validateArchive([{ name: 'bundle.zip', uncompressedSize: 10 }]);
    expect(nested.issues.some((issue) => issue.code === 'nested_archive')).toBe(true);

    const executable = validateArchive([{ name: 'setup.exe', uncompressedSize: 10 }]);
    expect(executable.issues.some((issue) => issue.code === 'nested_archive')).toBe(true);
  });

  it('rejects zip bombs by ratio and by absolute size', () => {
    const bomb = validateArchive(
      [{ name: 'bomb.vrm', uncompressedSize: 50_000_000, compressedSize: 1000 }],
      { ...DEFAULT_ARCHIVE_LIMITS, maxTotalBytes: 100_000_000 },
    );
    expect(bomb.issues.some((issue) => issue.code === 'compression_ratio')).toBe(true);

    const oversized = validateArchive([{ name: 'huge.vrm', uncompressedSize: 500_000_000 }]);
    expect(oversized.issues.some((issue) => issue.code === 'entry_too_large')).toBe(true);

    const many = validateArchive(
      Array.from({ length: 400 }, (_, index) => ({ name: `file-${index}.vrm`, uncompressedSize: 10 })),
    );
    expect(many.issues.some((issue) => issue.code === 'too_many_entries')).toBe(true);
  });

  it('rejects duplicate and unsupported entries', () => {
    const duplicate = validateArchive([
      { name: 'Avatar.VRM', uncompressedSize: 10 },
      { name: 'avatar.vrm', uncompressedSize: 10 },
    ]);
    expect(duplicate.issues.some((issue) => issue.code === 'duplicate_entry')).toBe(true);

    const unsupported = validateArchive([{ name: 'payload.sh', uncompressedSize: 10 }]);
    expect(unsupported.issues.some((issue) => issue.code === 'unsupported_type')).toBe(true);
  });

  it('joins extraction paths inside the app data directory only', () => {
    expect(resolveSafeEntryPath('/data/characters/aiko', 'animations/idle.vrma')).toBe(
      '/data/characters/aiko/animations/idle.vrma',
    );
    expect(resolveSafeEntryPath('/data/characters/aiko', '../../../../etc/passwd')).toBe(
      '/data/characters/aiko/etc/passwd',
    );
    expect(resolveSafeEntryPath('/data/characters/aiko', 'weird:name?.vrm')).toBe(
      '/data/characters/aiko/weird_name_.vrm',
    );
  });
});

describe('redaction', () => {
  it('removes keys, tokens and personal paths from diagnostics', () => {
    // Assembled at runtime so the repository never contains a key-shaped literal
    // that secret scanners (or GitHub push protection) would flag.
    const fakeKey = ['AIza', 'SyFAKEKEYNOTREAL1234567890abcdefg'].join('');
    const input = `failed with key ${fakeKey} for /Users/jane/secret/aura.sqlite`;
    const output = redactForDiagnostics(input);
    expect(output).not.toContain('AIza');
    expect(output).not.toContain('jane');
    expect(output).toContain('[redacted]');
    expect(redactSecrets('access_token=abcdefgh1234')).toContain('[redacted]');
    expect(redactError(new Error('boom at /home/user/x')).message).not.toContain('/home/user');
  });
});

describe('provider errors', () => {
  it('classifies retryable failures and never retries auth problems', () => {
    expect(isRetryableError(toProviderError(429, 'rate limited'))).toBe(true);
    expect(isRetryableError(toProviderError(500, 'boom'))).toBe(true);
    expect(isRetryableError(toProviderError(401, 'bad key'))).toBe(false);
    expect(isRetryableError(toProviderError(400, 'bad model'))).toBe(false);
    expect(isRetryableError(new Error('plain'))).toBe(false);
  });

  it('explains failures to the user in plain language', () => {
    expect(describeProviderError(toProviderError(401, ''))).toMatch(/key/i);
    expect(describeProviderError(toProviderError(429, ''))).toMatch(/rate limit|quota/i);
    expect(describeProviderError(undefined)).toMatch(/went wrong/i);
  });
});
