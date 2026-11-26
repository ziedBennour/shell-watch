import { expect, mock, test } from 'claude-code/testing'

const PANE = {
  plugin: 'shell-watch',
  component: 'Pane',
  requestId: 'shell-watch',
  props: {
    title: 'shell-watch',
    isFocused: false,
    bodyColumns: 100,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 60 },
    view: {},
  },
} as const

const MIN = 60_000
// Cache reads are left out of the token part: a big one changes nothing.
const model = (usd: number, tokens: number, time: number) => ({
  usd,
  input: tokens,
  cacheWrite: 0,
  cacheRead: 999_999,
  output: 0,
  time,
})
const day = {
  open: 0,
  work: 40 * MIN,
  usd: 1.2,
  models: { 'claude-opus-5-5': model(1, 710, 25 * MIN), 'claude-sonnet-5-5': model(0.2, 290, 0) },
}
const VIEW = { root: 'C:\projet', session: day, week: day, weekReset: true, total: day, since: '2026-10-30' }

test('Projet: the columns coût, token, temps, titled once, each model its parts and its time', async ($, on) => {
  mock.store(on)
  mock.env(on, {})
  // The view as the mod last drew it, kept under its shape.
  on('state.get', ($, e, next) =>
    e.key === 'project' ? { value: { value: { shape: 'project-4', value: VIEW }, version: 1 } } : next(e),
  )
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    const text = async (re: RegExp) => (await ui.find({ type: 'Text', text: re }))?.text
    expect(await text(/token/)).toBe('                                    coût  token  temps')
    expect(await text(/^séance/)).toBe('séance        $1.20  40m  1,80 $/h')
    expect(await text(/Opus/)).toBe('  Opus 5.5    $1.00       1,50 $/h   83%    71%    25m')
    // No time counted (before 0.20.0): a dash.
    expect(await text(/Sonnet/)).toBe('  Sonnet 5.5  $0.20       0,30 $/h   17%    29%      –')
    await ui.unmount()
  }
})
