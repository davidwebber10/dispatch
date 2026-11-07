import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { Command } from '@phosphor-icons/react';
import { Modal } from '../../common/Modal';
import { inputMenuRow } from '../../dictation/InputActionsMenu';
import { HARNESSES } from '../../../lib/harnesses';
import {
  EFFORT_LEVELS, parseSlash, resolveEffortArg, resolveModelArg, slashCommandsFor,
  type SlashHarness, type SlashSurface,
} from '../../../lib/slash';
import { SlashList, type SlashItem } from './SlashList';

/**
 * The "/" menu of Dispatch commands (slash menu, 2026-11-06). One hook per composer:
 *
 *   - Typing `/` at the very start opens a list above the box, filtered as you type. Arrow keys
 *     move, Enter or Tab choose, Escape closes. After `/model ` or `/effort ` the list shows the
 *     models or levels.
 *   - `interceptSend()` runs first in the host's send: a known command is run, never sent to the
 *     model; an unknown `/word` goes on as text (Codex first shows a hint).
 *   - A message that really starts with `/` needs a space before it. The list says so.
 *   - On a phone the + menu gets a Commands row that opens the same list as a sheet.
 *
 * The host supplies `run(name, args)`: it does the work and returns a note to show, or throws an
 * Error whose message is shown. It is the host that knows the thread.
 */
export interface UseSlashMenuOptions {
  surface: SlashSurface;
  harness: SlashHarness;
  value: string;
  setValue: (v: string) => void;
  /** The saved model and effort, to mark them in the option lists. */
  model?: string | null;
  effort?: string | null;
  run: (name: string, args: string) => Promise<string | void> | string | void;
  mobile: boolean;
  /** The efforts to list after `/effort `. Default: the harness's fixed list. Codex: the current model's own. */
  effortLevels?: readonly string[];
}

export interface SlashMenu {
  /** Render inside PillComposer's `slash` prop: the list, the notice and the phone sheet. */
  overlay: ReactNode;
  /** Pass as the text box's onKeyDown. It prevents the default only for a key it used. */
  onKeyDown: (e: KeyboardEvent<HTMLTextAreaElement>) => void;
  /** Call at the start of the host's send. True means "handled, do not send". */
  interceptSend: () => boolean;
  /** The + menu row (phone). */
  plusRow: (close: () => void) => ReactNode;
}

const NOTICE_MS = 6000;

export function useSlashMenu(o: UseSlashMenuOptions): SlashMenu {
  const { surface, harness, value, setValue, mobile } = o;
  const commands = useMemo(() => slashCommandsFor(surface, harness), [surface, harness]);
  const [active, setActive] = useState(0);
  const [dismissedFor, setDismissedFor] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ text: string; error: boolean } | null>(null);
  const [sheet, setSheet] = useState(false);
  const warnedFor = useRef<string | null>(null);
  const noticeTimer = useRef<ReturnType<typeof setTimeout>>();
  useEffect(() => () => clearTimeout(noticeTimer.current), []);

  const say = useCallback((text: string, error = false) => {
    clearTimeout(noticeTimer.current);
    setNotice({ text, error });
    noticeTimer.current = setTimeout(() => setNotice(null), NOTICE_MS);
  }, []);

  /** Run a command through the host, then clear the box and say what happened. */
  const valueRef = useRef(value); valueRef.current = value;
  const exec = useCallback(async (name: string, args: string, clear = true) => {
    const typed = valueRef.current;
    if (clear) setValue('');
    setSheet(false);
    try {
      const note = await o.run(name, args);
      if (note) say(note);
    } catch (e) {
      // A command that did not go through keeps what was typed, so it can be fixed and sent again.
      if (clear && !valueRef.current) setValue(typed);
      say(e instanceof Error ? e.message : 'The command did not go through.', true);
    }
  }, [o.run, setValue, say]); // eslint-disable-line react-hooks/exhaustive-deps

  const items: SlashItem[] = useMemo(() => {
    if (dismissedFor === value) return [];
    const word = /^\/([A-Za-z0-9_-]*)$/.exec(value);
    if (word) {
      const q = word[1].toLowerCase();
      return commands.filter((c) => c.name.startsWith(q)).map((c) => ({
        key: c.name, label: `/${c.name}`, description: c.description, disabledReason: c.disabledReason,
        run: () => (c.takesArgs ? setValue(`/${c.name} `) : void exec(c.name, '')),
        // `/model` typed out and Enter opens the picker; a second Enter must not pick an option by accident.
        runExact: c.takesArgs && q === c.name ? () => void exec(c.name, '') : undefined,
      }));
    }
    const arg = /^\/(model|effort)[ \t]+([^\s]*)$/i.exec(value);
    if (arg) {
      const name = arg[1].toLowerCase();
      const cmd = commands.find((c) => c.name === name);
      if (!cmd || cmd.disabledReason) return [];
      const q = arg[2].toLowerCase();
      if (name === 'model') {
        const list = HARNESSES.find((h) => h.type === harness)?.models ?? [];
        return list
          .filter((m) => !(harness === 'codex' && m.model === null))
          .filter((m) => (m.model ?? 'default').toLowerCase().startsWith(q) || m.label.toLowerCase().startsWith(q))
          .map((m) => ({ key: `m:${m.model}`, label: m.label, description: m.model ?? 'the default', current: (o.model ?? null) === m.model, run: () => void exec('model', m.model ?? 'default') }));
      }
      const levels = o.effortLevels ?? (harness === 'claude-code' || harness === 'codex' ? EFFORT_LEVELS[harness] : []);
      return levels.filter((l) => l.startsWith(q)).map((l) => ({ key: `e:${l}`, label: l, current: o.effort === l, run: () => void exec('effort', l) }));
    }
    return [];
  }, [value, dismissedFor, commands, harness, o.model, o.effort, o.effortLevels, setValue, exec]);

  // A new list starts at its first line.
  useEffect(() => { setActive(0); }, [items.length, value]);

  const onKeyDown = useCallback((e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (!items.length || e.nativeEvent.isComposing) return;
    const stop = () => { e.preventDefault(); e.stopPropagation(); };
    if (e.key === 'ArrowDown') { stop(); setActive((a) => (a + 1) % items.length); }
    else if (e.key === 'ArrowUp') { stop(); setActive((a) => (a - 1 + items.length) % items.length); }
    else if (e.key === 'Escape') { stop(); setDismissedFor(value); }
    else if ((e.key === 'Enter' && !e.shiftKey) || e.key === 'Tab') {
      const it = items[active] ?? items[0];
      stop();
      if (it.disabledReason) say(it.disabledReason, true);
      else if (e.key === 'Enter' && it.runExact) it.runExact();
      else it.run();
    }
  }, [items, active, value, say]);

  const interceptSend = useCallback((): boolean => {
    const slash = parseSlash(value);
    if (!slash) { warnedFor.current = null; return false; }
    if (!slash.known) {
      // Claude, Grok, OpenCode and Chat take it as text. Codex only passes it to the model: say so once.
      if (harness === 'codex' && surface !== 'chat' && warnedFor.current !== value) {
        warnedFor.current = value;
        say(`Codex has no /${slash.name} command, so it only reaches the model. Press Enter again to send it as text.`);
        return true;
      }
      return false;
    }
    const cmd = commands.find((c) => c.name === slash.name);
    if (!cmd) { say(`/${slash.name} is not available here.`, true); return true; }
    if (cmd.disabledReason) { say(`/${cmd.name}: ${cmd.disabledReason}.`, true); return true; }
    if (!cmd.takesArgs && slash.args) { say(`/${cmd.name} takes no extra words.`, true); return true; }
    void exec(cmd.name, slash.args);
    return true;
  }, [value, harness, surface, commands, exec, say]);

  const plusRow = useCallback((close: () => void) => (mobile ? (
    <button type="button" style={inputMenuRow()} onClick={() => { close(); setSheet(true); }}>
      <Command size={18} /> Commands
    </button>
  ) : null), [mobile]);

  const sheetItems: SlashItem[] = commands.map((c) => ({
    key: c.name, label: `/${c.name}`, description: c.description, disabledReason: c.disabledReason,
    run: () => void exec(c.name, '', false),
  }));

  const overlay = (
    <>
      {items.length > 0 ? (
        <div style={{ position: 'absolute', left: 0, right: 0, bottom: 'calc(100% + 6px)', zIndex: 40, padding: 6, maxHeight: 320, overflowY: 'auto', background: 'var(--color-elevated)', border: '1px solid var(--color-border)', borderRadius: 'var(--radius-lg)', boxShadow: '0 12px 34px -10px rgba(0,0,0,.7)' }}>
          {notice && (
            <div role={notice.error ? 'alert' : 'status'} style={{ padding: '4px 10px 6px', font: '400 12.5px var(--font-sans)', lineHeight: 1.4, color: notice.error ? 'var(--color-status-red)' : 'var(--color-text-secondary)' }}>
              {notice.text}
            </div>
          )}
          <SlashList items={items} active={active} onHover={setActive} mobile={mobile} />
        </div>
      ) : notice ? (
        <div role={notice.error ? 'alert' : 'status'} style={{ position: 'absolute', left: 6, right: 6, bottom: 'calc(100% + 4px)', font: '400 12.5px var(--font-sans)', lineHeight: 1.4, color: notice.error ? 'var(--color-status-red)' : 'var(--color-text-secondary)' }}>
          {notice.text}
        </div>
      ) : null}
      <Modal open={sheet} sheet title="Commands" onClose={() => setSheet(false)}>
        <SlashList items={sheetItems} active={-1} mobile />
      </Modal>
    </>
  );

  return { overlay, onKeyDown, interceptSend, plusRow };
}

/**
 * The shared body of `/model` and `/effort` for a host: no argument opens the picker; an argument
 * makes the change. `apply` makes it and returns the note to show. Everything else is the host's.
 */
export async function runModelEffortCommand(o: {
  harness: SlashHarness;
  name: 'model' | 'effort';
  args: string;
  openPicker: () => void;
  apply: (change: { model?: string | null; effort?: string }) => Promise<string | void>;
}): Promise<string | void> {
  if (!o.args) { o.openPicker(); return; }
  if (o.name === 'model') {
    const r = resolveModelArg(o.harness, o.args);
    if ('error' in r) throw new Error(r.error);
    return o.apply({ model: r.model });
  }
  const r = resolveEffortArg(o.harness, o.args);
  if ('error' in r) throw new Error(r.error);
  return o.apply({ effort: r.effort });
}
