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

test('over SSH the terminal rings, no player is run on the machine', async ($, on) => {
  mock.store(on)
  const runs: string[] = []
  on('process.run', (_, e) => {
    runs.push(e.argv[0] ?? '')
    // The SSH variables, as a session opened over SSH has them.
    const stdout = e.argv[0] === 'sh' ? '203.0.113.5 50000 10.0.0.1 22' : ''
    return { value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('session.machine', () => ({
    value: { sysname: 'Linux', release: '6', machine: 'x86_64', packageManagers: [], runtimes: [] },
  }))
  const rung: string[] = []
  on('ui.notify', (_, e) => {
    rung.push(e.text)
    return { value: { isSent: true, channel: 'terminal_bell' } }
  })
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'sound' })
  await ui.press({ key: 'sound' })
  expect(rung).toEqual(['Travail terminé'])
  expect(runs.includes('paplay')).toBe(false)
  await ui.unmount()
})
