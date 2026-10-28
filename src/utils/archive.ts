/**
 * Character bundle archive validation (PLAN §4.1, §14.1 security tests).
 *
 * The app never shells out to `unzip`; entries are inspected with the central
 * directory only, and every one of them must pass these checks before any data
 * is written. This blocks path traversal, absolute paths, symlinks, zip bombs
 * and disallowed file types.
 */

export interface ZipEntryLike {
  name: string;
  uncompressedSize?: number;
  compressedSize?: number;
  externalAttributes?: number;
  isDirectory?: boolean;
}

export interface ArchiveLimits {
  maxEntries: number;
  maxEntryBytes: number;
  maxTotalBytes: number;
  /** Reject an entry whose uncompressed:compressed ratio exceeds this. */
  maxCompressionRatio: number;
}

export const DEFAULT_ARCHIVE_LIMITS: ArchiveLimits = {
  maxEntries: 256,
  maxEntryBytes: 64 * 1024 * 1024,
  maxTotalBytes: 256 * 1024 * 1024,
  maxCompressionRatio: 200,
};

export type ArchiveIssueCode =
  | 'absolute_path'
  | 'path_traversal'
  | 'nested_archive'
  | 'symlink'
  | 'too_many_entries'
  | 'entry_too_large'
  | 'uncompressed_too_large'
  | 'compression_ratio'
  | 'unsupported_type'
  | 'duplicate_entry'
  | 'empty_name';

export interface ArchiveIssue {
  code: ArchiveIssueCode;
  entry: string;
  detail: string;
}

export interface ArchiveValidationResult {
  ok: boolean;
  issues: ArchiveIssue[];
  totalBytes: number;
  entries: string[];
}

const ALLOWED_EXTENSIONS = [
  '.vrm',
  '.vrma',
  '.glb',
  '.gltf',
  '.bin',
  '.png',
  '.jpg',
  '.jpeg',
  '.webp',
  '.json',
  '.md',
  '.txt',
  '.wav',
];

const NESTED_ARCHIVE_EXTENSIONS = ['.zip', '.tar', '.gz', '.tgz', '.7z', '.rar', '.exe', '.dll'];

export function validateArchive(
  entries: ZipEntryLike[],
  limits: ArchiveLimits = DEFAULT_ARCHIVE_LIMITS,
): ArchiveValidationResult {
  const issues: ArchiveIssue[] = [];
  const seen = new Set<string>();
  let totalBytes = 0;

  if (entries.length > limits.maxEntries) {
    issues.push({
      code: 'too_many_entries',
      entry: '*',
      detail: `Archive has ${entries.length} entries, limit is ${limits.maxEntries}`,
    });
  }

  for (const entry of entries) {
    const rawName = entry.name ?? '';
    const normalized = rawName.replace(/\\/g, '/').trim();

    if (!normalized) {
      issues.push({ code: 'empty_name', entry: rawName, detail: 'Entry has no name' });
      continue;
    }

    if (isAbsolutePath(normalized)) {
      issues.push({
        code: 'absolute_path',
        entry: normalized,
        detail: 'Absolute paths are not allowed in character bundles',
      });
      continue;
    }

    const segments = normalized.split('/').filter((segment) => segment.length > 0);
    if (segments.some((segment) => segment === '..')) {
      issues.push({
        code: 'path_traversal',
        entry: normalized,
        detail: 'Entry escapes the extraction root',
      });
      continue;
    }

    if (isSymlink(entry)) {
      issues.push({
        code: 'symlink',
        entry: normalized,
        detail: 'Symlinks are not allowed in character bundles',
      });
      continue;
    }

    if (seen.has(normalized.toLowerCase())) {
      issues.push({
        code: 'duplicate_entry',
        entry: normalized,
        detail: 'Duplicate entry name (case-insensitive)',
      });
      continue;
    }
    seen.add(normalized.toLowerCase());

    if (entry.isDirectory || normalized.endsWith('/')) {
      continue;
    }

    const lower = normalized.toLowerCase();
    const extension = lower.slice(lower.lastIndexOf('.'));
    if (NESTED_ARCHIVE_EXTENSIONS.includes(extension)) {
      issues.push({
        code: 'nested_archive',
        entry: normalized,
        detail: 'Nested archives and executables are rejected',
      });
      continue;
    }
    if (!ALLOWED_EXTENSIONS.includes(extension)) {
      issues.push({
        code: 'unsupported_type',
        entry: normalized,
        detail: `Unsupported file type ${extension || '(none)'}`,
      });
      continue;
    }

    const uncompressed = entry.uncompressedSize ?? 0;
    const compressed = entry.compressedSize ?? 0;
    if (uncompressed > limits.maxEntryBytes) {
      issues.push({
        code: 'entry_too_large',
        entry: normalized,
        detail: `Entry is ${uncompressed} bytes, limit is ${limits.maxEntryBytes}`,
      });
      continue;
    }
    totalBytes += uncompressed;
    if (totalBytes > limits.maxTotalBytes) {
      issues.push({
        code: 'uncompressed_too_large',
        entry: normalized,
        detail: `Bundle exceeds ${limits.maxTotalBytes} uncompressed bytes`,
      });
      break;
    }
    if (compressed > 0 && uncompressed / compressed > limits.maxCompressionRatio) {
      issues.push({
        code: 'compression_ratio',
        entry: normalized,
        detail: `Compression ratio ${(uncompressed / compressed).toFixed(1)}:1 looks like a zip bomb`,
      });
    }
  }

  return { ok: issues.length === 0, issues, totalBytes, entries: [...seen] };
}

function isAbsolutePath(name: string): boolean {
  return name.startsWith('/') || name.startsWith('\\') || /^[A-Za-z]:/.test(name);
}

function isSymlink(entry: ZipEntryLike): boolean {
  // Unix symlink mode bits live in the high 16 bits of external attributes.
  if (entry.externalAttributes === undefined) return false;
  const mode = (entry.externalAttributes >>> 16) & 0xffff;
  return (mode & 0xa000) === 0xa000;
}

/** Safe joined path for the extraction layer; always inside the app data dir. */
export function resolveSafeEntryPath(rootDir: string, entryName: string): string {
  const normalized = entryName.replace(/\\/g, '/');
  const segments = normalized
    .split('/')
    .filter((segment) => segment && segment !== '.' && segment !== '..')
    .map(sanitizeSegment);
  return [rootDir.replace(/\/+$/, ''), ...segments].join('/');
}

function sanitizeSegment(segment: string): string {
  // Strip control characters and the characters Windows forbids in file names.
  // Done as a code-point check so no control-character regex is required.
  return [...segment]
    .map((character) =>
      character.charCodeAt(0) < 0x20 || '<>:"|?*'.includes(character) ? '_' : character,
    )
    .join('')
    .slice(0, 120);
}
