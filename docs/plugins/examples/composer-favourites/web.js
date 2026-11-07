// Composer favourites — a spike plugin: a row of your own buttons under every composer, edited
// in Settings. Shows a plugin changing an existing screen (the composer) through its actions row.
export default function activate(d) {
  const { h, hooks: { useState }, ui, storage } = d;
  const PLUGIN = 'composer-favourites';
  const DEFAULTS = [
    { label: 'Summarise', text: 'Summarise where you are in one short paragraph, then list what is left.' },
    { label: 'Run tests', text: 'Run the test suite and report only the failures.' },
    { label: 'Commit & push', text: 'Commit what is done with a clear message and push the branch.' },
    { label: 'Explain', text: 'Explain your last change to me as if I had not read the code.' },
  ];
  // The list lives on the daemon; register again after a change so the composer shows the new buttons.
  const register = (favourites) => d.register(PLUGIN, {
    composerActions: favourites.map((f, i) => ({ id: `fav-${i}`, label: f.label, onClick: ({ value, set, insert }) => (value.trim() ? insert(f.text) : set(f.text)) })),
    settings: [{ id: 'favorites', label: 'Composer favourites', blurb: 'The buttons under the composer', icon: 'star', Component: Settings }],
  });

  function Settings() {
    const [favourites, setFavourites] = d.hooks.useDoc(PLUGIN, 'favorites', DEFAULTS);
    const [text, setText] = useState(null);
    const shown = text ?? favourites.map((f) => `${f.label} | ${f.text}`).join('\n');
    const save = async () => {
      const next = shown.split('\n').map((l) => l.trim()).filter(Boolean).map((l) => { const [label, ...rest] = l.split('|'); return { label: label.trim(), text: rest.join('|').trim() }; }).filter((f) => f.label && f.text);
      await setFavourites(next); register(next); setText(null); d.hint('Favourites saved');
    };
    return h('div', { style: { display: 'flex', flexDirection: 'column', gap: 10 } },
      h('span', { style: ui.styles.sectionLabel }, 'BUTTONS'),
      h('div', { style: { fontSize: 12.5, color: 'var(--color-text-secondary)' } }, 'One per line: Label | the text it puts in the composer.'),
      h('textarea', { value: shown, rows: 6, onChange: (e) => setText(e.target.value), style: { ...ui.styles.fieldInput, height: 'auto', padding: 9, font: '12.5px/1.5 var(--font-mono)', resize: 'vertical' } }),
      h('div', null, h('button', { style: ui.styles.solidBtn(true), onClick: save }, 'Save')));
  }
  storage.get(PLUGIN, 'favorites', DEFAULTS).then(register);
}
