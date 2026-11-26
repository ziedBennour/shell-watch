import type { On } from 'claude-code'
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

const RUN_OK = { exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false }
const MACHINE = { release: '10', machine: 'x86_64', packageManagers: [], runtimes: [] }

test('the button turns the sound off, then on', async ($, on) => {
  mock.store(on)
  mock.env(on, {})
  // The player is not run: the sound it would play, turned back on, is answered at once.
  on('process.run', () => ({ value: RUN_OK }))
  on('session.machine', () => ({ value: { sysname: 'Windows_NT', ...MACHINE } }))
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

/** A session opened over SSH on Linux; `relay` says whether the relay on the person's computer answers. */
function sshSession(on: On, relay: boolean) {
  mock.store(on)
  mock.clock(on)
  mock.env(on, { SSH_CONNECTION: '203.0.113.5 50000 10.0.0.1 22' })
  const seen = { runs: [] as string[], rung: [] as string[], relayed: 0 }
  on('process.run', (_, e) => {
    seen.runs.push(e.argv[0] ?? '')
    return { value: RUN_OK }
  })
  on('session.machine', () => ({ value: { sysname: 'Linux', ...MACHINE } }))
  on('http.fetch', (_, e) => {
    seen.relayed++
    expect(e.url).toBe('http://127.0.0.1:47823/done')
    return relay ? { value: { status: 204, ok: true, headers: {}, text: '' } } : { deny: 'connection refused' }
  })
  on('ui.notify', (_, e) => {
    seen.rung.push(e.text)
    return { value: { isSent: true, channel: 'terminal_bell' } }
  })
  return seen
}

test('over SSH the relay on the person computer plays it: no bell, no player here', async ($, on) => {
  const seen = sshSession(on, true)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'sound' })
  await ui.press({ key: 'sound' })
  expect(seen.relayed).toBe(1)
  expect(seen.rung).toEqual([])
  expect(seen.runs).toEqual([])
  await ui.unmount()
})

test('over SSH with no relay the terminal rings, no player is run on the machine', async ($, on) => {
  const seen = sshSession(on, false)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'sound' })
  await ui.press({ key: 'sound' })
  expect(seen.relayed).toBe(1)
  expect(seen.rung).toEqual(['Travail terminé'])
  expect(seen.runs).toEqual([])
  await ui.unmount()
})
