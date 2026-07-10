export class RingBuffer {
  private chunks: string[] = [];
  private totalSize = 0;
  private maxSize: number;
  private dropped = false; // oldest data has been trimmed — contents no longer start at process spawn
  public lastWriteAt: Date | null = null;

  // 4MB ≈ hours of TUI diff-frames: codex's spinner floods the ring, and the
  // scrolled-away transcript survives a reattach only if it's still in here.
  constructor(maxBytes: number = 4_000_000) {
    this.maxSize = maxBytes;
  }

  write(data: string): void {
    this.chunks.push(data);
    this.totalSize += Buffer.byteLength(data, 'utf8');
    this.lastWriteAt = new Date();
    while (this.totalSize > this.maxSize && this.chunks.length > 1) {
      const removed = this.chunks.shift()!;
      this.totalSize -= Buffer.byteLength(removed, 'utf8');
      this.dropped = true;
    }
  }

  /**
   * Whether getContents(maxBytes) would return everything the process has ever
   * written. False once the ring has trimmed old data OR the caller's cap cuts
   * the tail — either way a replay can't fully reconstruct a TUI's screen.
   */
  isReplayComplete(maxBytes?: number): boolean {
    if (this.dropped) return false;
    if (maxBytes && maxBytes > 0 && this.totalSize > maxBytes) return false;
    return true;
  }

  getContents(maxBytes?: number): string {
    if (!maxBytes || maxBytes <= 0 || this.totalSize <= maxBytes) {
      return this.chunks.join('');
    }

    const tail: string[] = [];
    let size = 0;

    for (let i = this.chunks.length - 1; i >= 0; i--) {
      const chunk = this.chunks[i];
      const chunkSize = Buffer.byteLength(chunk, 'utf8');
      if (size + chunkSize <= maxBytes) {
        tail.unshift(chunk);
        size += chunkSize;
        continue;
      }

      const remaining = maxBytes - size;
      if (remaining > 0) {
        const bytes = Buffer.from(chunk, 'utf8');
        tail.unshift(bytes.subarray(Math.max(0, bytes.length - remaining)).toString('utf8'));
      }
      break;
    }

    return tail.join('');
  }

  clear(): void {
    this.chunks = [];
    this.totalSize = 0;
    this.lastWriteAt = null;
    this.dropped = false;
  }
}
