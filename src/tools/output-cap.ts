/**
 * Keeps the first `head` and last `tail` lines of a stream while it is still arriving, so a
 * command that prints forever (`yes`) can't eat memory before its timeout.
 */
export class LineCapper {
  private readonly headLines: string[] = [];
  private readonly tailLines: string[] = [];
  private partial = '';
  private total = 0;

  constructor(
    private readonly head = 100,
    private readonly tail = 200,
    private readonly maxLineChars = 4000,
  ) {}

  push(chunk: string): void {
    const parts = (this.partial + chunk).split('\n');
    this.partial = parts.pop() ?? '';
    // A single never-ending line is still bounded.
    if (this.partial.length > this.maxLineChars)
      this.partial = this.partial.slice(0, this.maxLineChars);
    for (const line of parts) this.addLine(line);
  }

  /** Flushes a last line that had no trailing newline. */
  end(): void {
    if (this.partial !== '') this.addLine(this.partial);
    this.partial = '';
  }

  private addLine(raw: string): void {
    const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
    const capped =
      line.length > this.maxLineChars
        ? `${line.slice(0, this.maxLineChars)}…`
        : line;
    this.total++;
    if (this.headLines.length < this.head) {
      this.headLines.push(capped);
      return;
    }
    this.tailLines.push(capped);
    if (this.tailLines.length > this.tail) this.tailLines.shift();
  }

  get lineCount(): number {
    return this.total;
  }

  get dropped(): number {
    return this.total - this.headLines.length - this.tailLines.length;
  }

  render(): string {
    const middle =
      this.dropped > 0 ? [`… ${this.dropped} lines dropped …`] : [];
    return [...this.headLines, ...middle, ...this.tailLines].join('\n');
  }
}
