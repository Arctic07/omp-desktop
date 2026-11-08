/**
 * The slot module of the `renderer-slots-basic` template.
 *
 * A slot module is plain JavaScript loaded into this application's own document. It must not import
 * bare modules: the React it draws with is handed over as `host.react`, which is this application's
 * React and never a second copy. `onLoad` receives one `host` per load; nothing is written to
 * `window`, and everything registered here is removed when the load ends.
 *
 * The two registrations below are the smallest useful pair:
 *
 * - `composer.toolbar` puts a control beside the composer's toolbar (only the sides the manifest
 *   listed are drawn);
 * - `code.block` draws the fences tagged `<pluginId>:<language>` - here,
 *   ` ```renderer-slots-basic:example ` - and leaves every other fence to the application.
 *
 * `host.dispatch` only accepts the actions the manifest's `rendererActions` whitelisted, and
 * `plugin.call` only reaches the methods in `rendererCallMethods`. A refusal comes back as data
 * (`{ ok: false, code }`), never as a throw.
 */
export function onLoad(host) {
  const react = host.react
  let pending = false

  async function insertSnippet() {
    if (pending) return
    pending = true
    try {
      const draft = await host.dispatch('composer.readDraft')
      const prefix = draft.ok && typeof draft.value === 'string' && draft.value.length > 0 ? '\n' : ''
      await host.dispatch('composer.insertText', {
        text: `${prefix}Snippet from renderer-slots-basic.\n`,
      })
    } finally {
      pending = false
    }
  }

  function InsertSnippetButton() {
    return react.createElement(
      'button',
      {
        type: 'button',
        'data-omp-template': 'renderer-slots-basic',
        onClick: insertSnippet,
      },
      'Insert snippet',
    )
  }

  host.slots.register({
    slot: 'composer.toolbar',
    positions: ['left'],
    component: InsertSnippetButton,
  })

  host.slots.register({
    slot: 'code.block',
    language: 'example',
    component: ({ source, language }) =>
      react.createElement(
        'pre',
        { 'data-omp-template': 'renderer-slots-basic', 'data-language': language },
        String(source ?? ''),
      ),
  })
}
