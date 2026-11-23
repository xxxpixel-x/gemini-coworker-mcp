import fs from 'node:fs';
import type { AppConfig, ScrubberLike } from '../types.js';
import { resolveAllowedFilePath } from './workspaceSecurity.js';

export function loadScrubbedTextFiles(
  deps: { config: AppConfig; scrubber: ScrubberLike },
  filePaths: string[],
  workspaceRoot?: string,
  maxTotalBytes = 180_000,
): { textBlock: string; includedFiles: string[] } {
  if (filePaths.length === 0) return { textBlock: '', includedFiles: [] };
  if (filePaths.length > 20) {
    throw new Error('At most 20 files may be attached in a single call.');
  }

  const sections: string[] = [];
  const includedFiles: string[] = [];
  let totalBytes = 0;

  for (const fp of filePaths) {
    const resolved = resolveAllowedFilePath({
      filePath: fp,
      workspaceRoot,
      allowedRoots: deps.config.allowedWorkspaceRoots,
      mustExist: true,
    });
    const stat = fs.statSync(resolved.absolutePath);
    if (!stat.isFile()) {
      throw new Error(`Not a file: "${resolved.displayPath}"`);
    }
    if (stat.size > 512 * 1024) {
      throw new Error(`Text file exceeds 512KB cap: "${resolved.displayPath}"`);
    }
    const raw = fs.readFileSync(resolved.absolutePath, 'utf8');
    if (raw.includes('\0')) {
      throw new Error(
        `File "${resolved.displayPath}" appears to be binary. Only text attachments are supported.`,
      );
    }
    const scrubbed = deps.scrubber.scrub(raw);
    const numbered = scrubbed
      .split(/\r?\n/)
      .map((line, i) => `${i + 1}: ${line}`)
      .join('\n');
    const block = `### File: ${resolved.displayPath}\n\`\`\`\n${numbered}\n\`\`\``;
    const blockBytes = Buffer.byteLength(block, 'utf8');
    if (totalBytes + blockBytes > maxTotalBytes) {
      const remaining = Math.max(0, maxTotalBytes - totalBytes - 200);
      if (remaining > 400) {
        sections.push(
          `### File: ${resolved.displayPath} (truncated)\n\`\`\`\n${numbered.slice(0, remaining)}\n... [TRUNCATED]\n\`\`\``,
        );
        includedFiles.push(`${resolved.displayPath} (truncated)`);
      }
      break;
    }
    sections.push(block);
    includedFiles.push(resolved.displayPath);
    totalBytes += blockBytes;
  }

  return { textBlock: sections.join('\n\n'), includedFiles };
}
