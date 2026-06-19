export class RingBuffer {
  private chunks: string[] = [];
  private totalSize = 0;
  private maxSize: number;
  public lastWriteAt: Date | null = null;

  constructor(maxBytes: number = 1_000_000) {
    this.maxSize = maxBytes;
  }

  write(data: string): void {
    this.chunks.push(data);
    this.totalSize += Buffer.byteLength(data, 'utf8');
    this.lastWriteAt = new Date();
    while (this.totalSize > this.maxSize && this.chunks.length > 1) {
      const removed = this.chunks.shift()!;
      this.totalSize -= Buffer.byteLength(removed, 'utf8');
    }
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
  }
}
