/** Best-effort first-line capture for raw terminal input. Never interpret terminal output. */
export class PromptInput {
  private text = '';
  private escape = '';
  private paste = false;
  private uncertain = false;

  feed(chunk: string): string[] {
    const prompts: string[] = [];
    for (const char of chunk) {
      if (this.escape) {
        this.escape += char;
        if (this.escape.length > 32) { this.escape = ''; this.uncertain = true; continue; }
        if (this.escape === '\x1b[') continue;
        if (this.escape.startsWith('\x1b[') && !/[A-Za-z~]/.test(char)) continue;
        if (this.escape === '\x1b[200~') this.paste = true;
        else if (this.escape === '\x1b[201~') this.paste = false;
        else this.uncertain = true; // history/cursor editing: trust the transcript instead
        this.escape = '';
        continue;
      }
      if (char === '\x1b') { this.escape = char; continue; }
      if ((char === '\r' || char === '\n') && !this.paste) {
        if (!this.uncertain && this.text.trim()) prompts.push(this.text.trim());
        this.text = ''; this.uncertain = false;
      } else if (char === '\x03' || char === '\x15') {
        this.text = ''; this.uncertain = false;
      } else if (char === '\x7f' || char === '\b') {
        this.text = Array.from(this.text).slice(0, -1).join('');
      } else if (char === '\t' || char < ' ' && char !== '\n' && char !== '\r') {
        this.uncertain = true;
      } else if (this.text.length < 16000) this.text += char;
    }
    return prompts;
  }
}
