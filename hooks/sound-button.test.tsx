import { expect, mock, test } from 'claude-code/testing'

const PANE = {
  plugin: 'shell-watch',
  component: 'Pane',
  requestId: 'shell-watch',
  props: {
    title: 'shell-watch',
    isFocused: false,
    bodyColumns: 90,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 40 },
    view: {},
  },
} as const

test('the button turns the sound off, then on', async ($, on) => {
  mock.store(on)
  // The player is not run: the sound it would play, turned back on, is answered at once.
  on('process.run', () => ({ value: { exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }))
  on('session.machine', () => ({
    value: { sysname: 'Windows_NT', release: '10', machine: 'x86_64', packageManagers: [], runtimes: [] },
  }))
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect((await ui.find({ type: 'Text', text: /son activé/ }))?.text).toBe('♪ son activé')
    await ui.press({ key: 'sound' })
    expect((await ui.find({ type: 'Text', text: /son coupé/ }))?.text).toBe('♪ son coupé')
    await ui.press({ key: 'sound' })
    expect((await ui.find({ type: 'Text', text: /son activé/ }))?.text).toBe('♪ son activé')
    await ui.unmount()
  }
})
