# Settings layout guide

One layout for every Settings section, taken from what already shipped: Settings → Plugins
(`packages/web/src/components/settings/PluginsSection.tsx`) and Settings → Coach
(`packages/plugins/coach/web.js`, `Settings()`). Every primitive named here is exported from
`packages/web/src/components/settings/ui.tsx`, `packages/web/src/components/common/` or
`packages/web/src/components/ui/` (the buttons, menus and popovers: part 9).

A section keeps its own content and order. It uses these parts to show that content.

## 1. Page anatomy

```tsx
<SettingsPage intro="Plugins add screens and tools to Dispatch. Bundled ones update with the app.">
  <SettingsGroup title="Bundled" footer="One quiet line under the card, if it helps.">
    <SettingsRow … />
    <SettingsRow … />
  </SettingsGroup>
  <SettingsGroup title="Safe mode">…</SettingsGroup>
</SettingsPage>
```

- **Title**: the shell shows it (the desktop content header, the phone app header). Do not repeat it.
- **Intro**: at most one line or two short sentences (`SettingsPage intro`). Leave it out when the
  group titles say enough. No "THIS DEVICE · everything here…" mono banners.
- **Groups** (`SettingsGroup`): a small uppercase label over one card. Rows in the card are split
  by a hairline. `title` is a short noun phrase in sentence case ("Cost and models"); the
  component uppercases it. `action` puts one ghost button at the right of the label
  ("New plugin…", "Export"). `footer` is one quiet note under the card.
- Groups sit 20px apart (`SettingsPage` does this). A group is the unit; do not use `<Divider />`
  or `GroupHeader` hairlines between parts of a page.
- Say "this device" vs "all devices" in the group title or hint only when it matters
  ("Show the paused banner on this device"), not as a page-wide banner.

## 2. Row types

All rows are `SettingsRow` (padding 11px 12px; label 13.5px primary; hint 12px tertiary).

| Row | Use | Code |
|---|---|---|
| Switch row | on/off | `<SettingsRow label="Auto-update" hint="…" control={<Toggle on={x} label="Auto-update" onClick={…} />} />` |
| Value row → sub-page or picker | a choice that needs its own page or sheet | `<SettingsRow label="Theme" value="Dispatch Dark" onClick={open} />` (the whole row taps; a chevron ends it) |
| Read-only value | a version, a count, an address | `<SettingsRow label="Version" value="v4.0.1" />` |
| Short choice | a short dropdown (≤ 160px) | `control={<Select ariaLabel="Open docs in" value={v} options={…} onChange={…} style={{ width: 160 }} />}` |
| Wide choice | 2–5 options | label + hint, then `<Segmented ariaLabel="How often" value={v} options={[{ value, label, hint }]} onChange={…} />` as **children** (its own full-width line; the picked option's hint shows under it) |
| Multi pick | a subset of a list | `control={<MultiSelect ariaLabel="Projects" noun={['project','projects']} allLabel="All projects" … />}` |
| Number | a small number | `control={<Stepper value="80" unit="%" onDec={…} onInc={…} />}` or a 70px input with `fieldFor(isMobile)` |
| Input row | text, a URL, a key | label + hint, then the field(s) as **children**, full width: `<input style={{ ...fieldFor(isMobile), width: '100%' }} />`; a Save/Add `<Button variant="primary" size="sm">` at the end of that line |
| List-of-items row | one thing among many (plugin, account, device, integration, server, skill) | `<SettingsRow icon={PuzzlePiece} label={name} hint={oneLine} control={<Toggle …/>} onClick={() => openItem(id)} />` — one line of text, the item's own page holds the rest |
| Status row | a state | `<SettingsRow label="Connection" control={<StatusMark tone="accent">Connected</StatusMark>} />` |
| Destructive row | remove, sign out, revoke all | `<SettingsRow label="Remove plugin" danger onClick={askFirst} />` or `<Button variant="danger" size="sm">` |

Rules:
- A control on the right is small: a `Toggle`, a short `Select`, a `Stepper`, one ghost button.
  Anything wider goes in `children` so the label never squeezes.
- A list row shows **one** line under the name: the description, or (when something needs
  attention) a `StatusMark` instead. Never stack three lines of mono meta text in a row.
- Per-item actions (Rename, Revoke, Sign in, Remove) live on the item's sub-page, not as a row
  of buttons on every list row. One icon action on the row is fine when there is no sub-page.
- Status uses `ToneDot` / `StatusMark` with `TONE_VAR` tones only: `accent` (good), `yellow`
  (needs a look), `red` (broken), `muted` (off). Show a status only when it says something:
  Plugins shows nothing when all is well.

## 3. Sub-page vs disclosure vs inline

- **Inline**: the setting is one control. Most rows.
- **Sub-page** (`SettingsSubPage`): one item of a list has more than two settings or actions
  (a plugin, an account, a device, an integration, a skill). Header = `IconTile` 48 + title +
  one subtitle line ("v1.0.0 · Bundled") + description; then groups. Desktop: pass
  `onBack` and `backLabel="Plugins"` (accent "‹ Plugins" link). Phone: leave `onBack` out; the
  app header carries back (see `stores/mobileNav.ts` for how Plugins keeps the page in history).
- **Disclosure** (`SettingsDisclosure label="Developer" hint="Paths, ids, the worker command."`):
  rarely needed detail for builders or tuners (Developer, Advanced). Always last but one, above
  the destructive group. Closed by default.
- **Sheet** (`Sheet`, the shared slide-up `Modal`): an add-item form ("Add an integration") or a
  long picker. The list stays calm; the "Add…" button sits in the group's `action` slot or as a
  last row.

## 4. Destructive actions

- At the bottom of the page or sub-page, in their own group ("Remove", "Sign out every device").
- Red text (`danger` row or `<Button variant="danger">`), never a solid red button on the page.
  (In the action row of a `ConfirmModal` the same variant is the filled red button.)
- Always a `ConfirmModal danger confirmLabel="Remove plugin"` first; its message says what goes
  and what stays, in plain words.

## 5. Empty states

`<EmptyState action={<Button variant="ghost" size="sm">Add a server…</Button>}>No other servers yet. Add one to switch to it from the brand menu.</EmptyState>`
in place of the card. One or two plain sentences: what is missing, and what to do. No icon art.

## 6. Text

- Hints: one line, plain words, no jargon, no "e.g.". Say what the setting does, not how it is built.
- Sentence case for labels and buttons. US spelling ("color", "canceled", "behavior").
- Mono (`var(--font-mono)`) only for real code: paths, commands, ids, URLs, model ids.
- No emoji. Icons are Phosphor (`@phosphor-icons/react`) only.

## 7. Size and spacing

| What | Value |
|---|---|
| Between groups | 20px (`SettingsPage`) |
| Group label → card | 6px; label 10px mono, 1.2px tracking, tertiary |
| Row padding | 11px 12px; label/hint gap 2px; row → its children 10px |
| Card | `--color-pane`, 1px `--color-border`, `--radius-lg` |
| Sub-page | max-width 640px, 18px between parts |
| Desktop content | the shell gives max-width 860px; keep a list page there, a sub-page at 640 |
| Phone | full width with the shell's 14px gutter; Segmented and Select switch to the `lg` size themselves; inputs use `fieldFor(true)` (16px text, 36px tall: iOS does not zoom) |
| Icon tile | 32px on a row, 48px in a sub-page header |

## 8. Hard rules (tests enforce the first two and the last)

- No native `<select>` (`src/lib/noNativeSelect.test.ts`): use `Select`, `SearchSelect`, `MultiSelect`, `Segmented`.
- Colors from tokens only (`src/lib/colorLiterals.test.ts`): `var(--color-…)`, `TONE_VAR`.
- Phosphor icons only; no emoji; US spelling.
- Each section stays shared by desktop (`SettingsView`) and phone (`MobileSettings`); use
  `useIsMobile()` only for sizes and the back link, not for a second layout.

- No raw `<button>` with an inline style for an ordinary button: use `Button` or `IconButton`
  (`src/test/raw-button-ratchet.test.ts` fails when the count of raw buttons in Settings and
  the dialogs goes up).

## 9. Buttons, menus, popovers and dialogs (`components/ui`)

The UI primitives (engineering program 2026-11-09, W3-E). Their look is classes in
`components/ui/ui.css`, not inline style objects.

| Primitive | Use | Code |
|---|---|---|
| `Button` | every ordinary button | `<Button variant="ghost" size="sm" onClick={…}>Check now</Button>` |
| `IconButton` | a button that is only an icon | `<IconButton label="Remove server" icon={<Trash size={16} />} onClick={…} />` |
| `Menu` | a list of actions on a control | `<Menu open={open} anchor={ref} label="Thread actions" items={[{ id, label, icon, onSelect }]} onClose={…} />` |
| `Popover` | free content on a control | `<Popover open={open} anchor={ref} label="Filters" onClose={…}>…</Popover>` |
| `Modal`, `ConfirmModal` | a dialog, a confirm | `common/Modal.tsx`, `common/ConfirmModal.tsx` |

Button variants:

| Variant | Look | Use |
|---|---|---|
| `primary` | filled accent | the one main action: Save, Add, Connect, Update |
| `secondary` | filled quiet | Cancel in a dialog's action row |
| `ghost` | outline | most buttons on a page: Check now, Cancel, Add server… |
| `danger` | outline, red text | Remove, Revoke. Filled red only in a confirm dialog's action row |

Sizes: `sm` is 30px tall (a page), `md` is 34px (a dialog's action row). On a phone a form's
buttons are taller: pass `style={{ height: isMobile ? 36 : 30 }}`, as the fields do.

Rules:
- Pass `icon={<Plus size={12} weight="bold" />}` for an icon before the label. Do not put the icon
  in the children.
- Pass `loading` while the action runs: the button is disabled, shows a spinner and keeps its width.
- A disabled `Button` dims to 0.5 by itself. Do not set `opacity` or `cursor` for that.
- Pass `style` only for layout in the parent (`flex: 1`, `alignSelf`) or the phone height. Do not
  set a color, a border or a radius there.
- `IconButton` needs `label`. It is the accessible name and the hover title. It has no padding
  and a fixed square (`sm` 24px, `md` 32px), so its icon is never squeezed.
- `Menu` and `Popover` close on Escape and on a press outside, stay inside the window and open
  above the dialog that holds them. `Menu` moves with the arrow keys, Home and End.
- `Modal` and `ConfirmModal` move focus into the dialog, keep Tab inside it, close on Escape and
  give focus back to the control that opened them. Do not add a second Escape listener.
- The keyboard focus ring is one rule (`:focus-visible` in `ui.css`): a 2px accent outline. Do not
  set `outline: none` on a control without another clear focus mark.

Tokens (`theme.css`), for new code:

| Scale | Tokens | Values |
|---|---|---|
| Type | `--text-xs` `--text-sm` `--text-base` `--text-md` `--text-lg` `--text-xl` | 11, 12, 13, 14, 16, 19px |
| Space | `--space-1` … `--space-8` | 4, 8, 12, 16, 20, 24, 32, 40px |
| Layer | `--z-base` `--z-sticky` `--z-overlay` `--z-dropdown` `--z-modal` `--z-toast` | 0, 10, 100, 300, 400, 1000 |

Layers: `--z-overlay` is a dialog and its scrim; `--z-dropdown` is above it, so a menu opens over
the dialog that holds it; `--z-modal` is a confirm dialog, above both. The existing pages still
hold literal sizes (12.5px, 13.5px) and literal z-index values; they move to the scales one area
at a time, with before and after screenshots.

## Primitive reference (`settings/ui.tsx`)

```ts
SettingsPage({ intro?, children, style? })
SettingsGroup({ title?, footer?, action?, children, style? })
SettingsRow({ label, hint?, control?, children?, value?, onClick?, danger?, icon?, ariaLabel?, style? })
SettingsSubPage({ title, subtitle?, description?, icon?, backLabel?, onBack?, children, testId?, headerTestId? })
SettingsDisclosure({ label, hint?, defaultOpen?, children, testId? })
EmptyState({ children, action? })
ToneDot({ tone, size? })        StatusMark({ tone, children })      TONE_VAR, type Tone
IconTile({ icon, size?, dim? })  Toggle({ on, onClick, label?, disabled? })  Stepper  Sheet
styles: fieldInput, fieldFor(phone), noteText, codeChip, miniChip
        (ghostBtn, solidBtn(on), dangerBtn: for plugins only; the app uses Button)
common/: Segmented, Select, MultiSelect, SearchSelect, ConfirmModal, Modal
ui/:     Button({ variant, size, icon?, loading?, ...button attributes })
         IconButton({ label, icon, size?, ...button attributes })
         Menu({ open, onClose, anchor, items, label, placement? })
         Popover({ open, onClose, anchor, placement?, label?, children })
```
