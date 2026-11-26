import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type {
  AgentRun,
  AgentRunStatus,
  Limit,
  Pace,
  ProjDay,
  ProjectView,
  Section,
  Shell,
  ShellFilter,
  ShellStatus,
  Tokens,
  Usage,
} from '../types'
import {
  type Archive,
  type GitEntry,
  type ProcRec,
  GIT_DIR,
  addInto,
  dayKey,
  dayShift,
  dayTime,
  emptyDay,
  emptyModel,
  entryDays,
  firstDay,
  foreignEntries,
  gitFileText,
  hourKey,
  keptHours,
  localEntries,
  mergeArchive,
  mergeDays,
  planCompaction,
  roundArchive,
  roundDay,
  stepWeight,
  sumDays,
  sumSince,
  toArchive,
  toGitEntries,
  toProc,
} from './project'

// shell-watch: a pane that streams the output of every Bash command Claude
// runs (foreground and background), the subagents at work, plus
// subscription limits, context and cost.
//
// Claude Code writes each running command's output to
// <tmp>/claude-<uid>/<project>/<session>/tasks/<id>.output; a timer tails
// those files. A foreground file is deleted when the command ends, so the
// final output comes from the tool result instead.
//
// Pace: each 5h / 7d reading is kept in $.store, a file under ~/.claude
// shared by every session and project, so the pane can say how fast each
// window fills (%/h) and when it would run out at that rate.

const PANE = 'shell-watch'
const TITLE = 'Shells & usage'
const MAX_SHELLS = 200
const MAX_AGENTS = 50
const TAIL_LINES = 60
const TICK_MS = 1000
const BIG_FILE = 256 * 1024

const MIN = 60_000
const HOUR = 60 * MIN
const DAY = 24 * HOUR
const HIST_KEY = 'pace-history-1'
const HIST_KEEP = 8 * DAY
const HIST_MAX = 6000
const SYNC_MS = 30_000
const USAGE_POLL = 5 * MIN

const shells = atom({ plugin: 'shell-watch', key: 'shells' } as const, [] as Shell[], { shape: 'shells-1' })
const usage = atom({ plugin: 'shell-watch', key: 'usage' } as const, { at: 0, limits: [] } as Usage, {
  shape: 'usage-1',
})
const expanded = atom({ plugin: 'shell-watch', key: 'expanded' } as const, null as string | null, {
  shape: 'expanded-1',
})
// filter-2: the six filters; a value stored by 0.4.0 ('live', 'closed') reads as 'all'.
const filter = atom({ plugin: 'shell-watch', key: 'filter' } as const, 'all' as ShellFilter, { shape: 'filter-2' })
const tokens = atom(
  { plugin: 'shell-watch', key: 'tokens' } as const,
  { sid: '', since: 0, total: 0 } as Tokens,
  { shape: 'tokens-2' },
)
const agents = atom({ plugin: 'shell-watch', key: 'agents' } as const, [] as AgentRun[], { shape: 'agents-1' })
const projectView = atom(
  { plugin: 'shell-watch', key: 'project' } as const,
  { root: '', session: emptyDay(), week: emptyDay(), weekReset: false, total: emptyDay(), since: '' } as ProjectView,
  { shape: 'project-3' },
)
const folded = atom({ plugin: 'shell-watch', key: 'folded' } as const, [] as Section[], { shape: 'folded-1' })
const proc = atom({ plugin: 'shell-watch', key: 'proc' } as const, '', { shape: 'proc-1' })

const FOLD_KEY = 'folded-1'
const SECTIONS: readonly unknown[] = ['usage', 'project', 'agents', 'shells'] satisfies Section[]

/** Whether a shell belongs to a filter. */
const matches = (s: Shell, f: ShellFilter) =>
  f === 'all' ||
  (f === 'running' && s.status === 'running') ||
  (f === 'background' && s.status === 'background') ||
  (f === 'success' && (s.status === 'done' || s.status === 'bg-done')) ||
  (f === 'error' && (s.status === 'failed' || s.status === 'bg-failed')) ||
  (f === 'stopped' && s.status === 'interrupted')

const FILTER_EMPTY: Record<ShellFilter, string> = {
  all: '',
  running: 'en cours',
  background: 'en fond',
  success: 'réussi',
  error: 'en erreur',
  stopped: 'stoppé',
}

// An output line that reads as an error, drawn in red.
// English words by word boundary; French ones without (\b ignores accents).
const ERROR_LINE =
  /\b(error|erreur|exception|traceback|failed|failure|fatal|panic|denied|refused|not found|no such file|cannot|unable to)\b|impossible|introuvable|échec|aucun fichier|refusé|non trouvé|permission non accordée/i

// Module variables: lost on reload, which is fine (they are caches).
let timer: { cancel: () => void } | null = null
let busy = false
let dirCache: { sid: string; dir: string } | null = null
// Effort of the last main-loop request; only `turn.step` carries it.
let stepEffort: string | undefined
const sizes = new Map<string, number>()

// Readings of the rate-limit windows: [time, percent, resetsAt] per kind,
// mirrored from $.store and merged with it every SYNC_MS.
type Sample = [t: number, p: number, r: number]
let hist: Record<string, Sample[]> | null = null
let histDirty = false
let histSyncedAt = 0
let histFailed = false
// This session's last reading per kind: only a change is a new reading.
const seen = new Map<string, string>()
// Windows only /usage shows (a model's own week, Fable's), read every USAGE_POLL.
let extraLimits: Limit[] = []
let usagePolledAt = 0
let usagePolling = false
let usageFailed = false

const isLive = (s: Shell) => s.status === 'running' || s.status === 'background'

// Never break a tool call or a timer over display bookkeeping, but say why.
const safe = async ($: EngineInterface, fn: () => Promise<unknown>) => {
  try {
    await fn()
  } catch (err) {
    $.ui.log(`shell-watch: ${String(err)}`)
  }
}

// State holds plain JSON only: an `undefined` field gets the write refused.
const clean = <T extends object>(o: T): T =>
  Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as T

const putShells = ($: EngineInterface, fn: (list: Shell[]) => Shell[]) =>
  update($, shells, list => fn(list).map(clean))

// --- text helpers ------------------------------------------------------------

const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07]*(?:\x07|\x1b\\)|\x1b[@-Z\\-_]/g

const lastLines = (text: string, n = TAIL_LINES): string[] => {
  const lines = text
    .replace(ANSI, '')
    .replace(/\r\n/g, '\n')
    .split('\n')
    // a progress bar redraws with \r: keep what is left on screen
    .map(l => (l.split('\r').pop() ?? '').replace(/[\x00-\x08\x0b-\x1f\x7f]/g, ''))
  while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop()
  return lines.slice(-n)
}

const fmtDur = (ms: number) => {
  const s = Math.max(0, Math.floor(ms / 1000))
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m${String(s % 60).padStart(2, '0')}`
  return `${Math.floor(m / 60)}h${String(m % 60).padStart(2, '0')}`
}

const DAYS = ['dim.', 'lun.', 'mar.', 'mer.', 'jeu.', 'ven.', 'sam.']
const two = (n: number) => String(n).padStart(2, '0')

const MONTHS = ['janv.', 'févr.', 'mars', 'avr.', 'mai', 'juin', 'juil.', 'août', 'sept.', 'oct.', 'nov.', 'déc.']

/** "jeu. 30 oct. 2026" */
const fmtDate = (ms: number) => {
  const d = new Date(ms)
  return `${DAYS[d.getDay()]} ${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear()}`
}

/** claude-opus-5-5 → "Opus 5.5", claude-sonnet-4-5[1m] → "Sonnet 4.5 (1M)" */
const prettyModel = (id: string) => {
  const isLong = /\[1m\]/i.test(id)
  const base = id.replace(/\[.*?\]/g, '').trim()
  const m = /claude-([a-z]+)-(\d+)(?:-(\d{1,2})(?!\d))?/i.exec(base)
  const family = m?.[1] ?? ''
  const name = m
    ? `${family.charAt(0).toUpperCase()}${family.slice(1)} ${m[2] ?? ''}${m[3] ? `.${m[3]}` : ''}`
    : base.charAt(0).toUpperCase() + base.slice(1)
  return isLong ? `${name} (1M)` : name
}

const EFFORT: Record<string, { label: string; level: number }> = {
  low: { label: 'low', level: 1 },
  medium: { label: 'medium', level: 2 },
  high: { label: 'high', level: 3 },
  xhigh: { label: 'xhigh', level: 4 },
  max: { label: 'max', level: 5 },
}

/** "15m", "2h 15m", "1j 3h" */
const fmtSince = (ms: number) => {
  const m = Math.max(0, Math.floor(ms / 60_000))
  if (m < 60) return `${m}m`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h ${two(m % 60)}m`
  return `${Math.floor(h / 24)}j ${h % 24}h`
}

const clockHM = (ms: number) => {
  const d = new Date(ms)
  return `${two(d.getHours())}:${two(d.getMinutes())}`
}

const fmtReset = (iso: string | undefined, now: number) => {
  if (!iso) return ''
  const t = Date.parse(iso)
  if (Number.isNaN(t)) return ''
  const left = t - now
  if (left <= 0) return 'reset imminent'
  return `reset dans ${fmtIn(left)} (${fmtAt(t, now)})`
}

/**
 * A window at this pace, cut in cells for a single line: what is left at the
 * reset ("+57%"), or how far past 100 % it goes when the limit falls first
 * ("-15%"), and when the reset is: "dans 3h50 (09:30)".
 */
type Cells = { left: string; hit: boolean; reset: string }
const limitCells = (l: Limit, p: Pace | undefined, now: number): Cells => {
  const t = l.resetsAt ? Date.parse(l.resetsAt) : NaN
  const reset = Number.isNaN(t) ? '' : t <= now ? 'imminent' : `dans ${fmtIn(t - now)} (${fmtAt(t, now)})`
  if (!p || p.rate === undefined || l.percent >= 100) return { left: '', hit: false, reset }
  if (p.hitAt !== undefined) return { left: p.over !== undefined ? `-${Math.round(p.over)}%` : '', hit: true, reset }
  return { left: `+${100 - Math.round(p.atReset ?? 0)}%`, hit: false, reset }
}

/** After the %: "+57% au reset dans 3h50 (09:30)", "reset" aligned on the others' when there is no pace. */
const limitTail = (c: Cells, wl: number) => {
  if (!c.left && !c.reset) return ''
  const lead = c.left ? `${c.left.padStart(wl)} au ` : wl ? ' '.repeat(wl + 4) : ''
  return `${lead}reset${c.reset ? ` ${c.reset}` : ''}`
}

const cap = (t: string) => t.charAt(0).toUpperCase() + t.slice(1)

const kindLabel = (kind: string) =>
  kind === 'five_hour'
    ? '5h'
    : kind === 'seven_day'
      ? '7j'
      : kind === 'spend_limit'
        ? 'budget'
        : kind.startsWith('seven_day_')
          ? cap(kind.slice('seven_day_'.length).replace(/_/g, ' '))
          : kind.replace(/^five_hour_/, '5h ').replace(/_/g, ' ')

// Vesper (the VS Code theme in use): near-black, white and greys,
// a peach accent, mint for success, soft red for errors.
const C = {
  base: '#101010', // editor.background
  card: '#161616', // tab.activeBackground
  term: '#0a0a0a',
  track: '#343434', // scrollbarSlider.hoverBackground
  text: '#ffffff', // editor.foreground
  textSoft: '#c4c4c4', // titles of shells that succeeded
  sub: '#a0a0a0', // sideBarTitle.foreground
  dim: '#707070',
  accent: '#ffc799', // focusBorder, button.background
  mint: '#629f8f', // Vesper's #99FFE4, muted 40% toward the background
  red: '#9f5353', // Vesper's #FF8080, muted 40% toward the background
  orange: '#ff7300',
  lilac: '#a99be0', // the effort, apart from the folder (accent) and the model (mint)
} as const

const level = (pct: number) => (pct >= 80 ? C.red : pct >= 50 ? C.accent : C.mint)

const barParts = (pct: number, width: number) => {
  const full = Math.max(0, Math.min(width, Math.round((pct / 100) * width)))
  return { on: '━'.repeat(full), off: '━'.repeat(width - full) }
}

const fmtTokens = (n: number) =>
  n >= 1_000_000 ? `${+(n / 1_000_000).toFixed(1)}M` : n >= 1000 ? `${Math.round(n / 1000)}k` : String(n)

/** French decimals: 2,4 */
const fr = (n: number, digits: number) => n.toFixed(digits).replace('.', ',')


/** A token count with one decimal under 10k: "850", "2,4k", "31k", "1,2M" */
const fmtTok = (n: number) =>
  n >= 1_000_000 ? `${fr(n / 1_000_000, 1)}M` : n >= 10_000 ? `${Math.round(n / 1000)}k` : n >= 1000 ? `${fr(n / 1000, 1)}k` : String(Math.round(n))

/** A time ahead: "15:40" today, "jeu. 14:00" later */
const fmtAt = (t: number, now: number) => {
  const d = new Date(t)
  const hm = `${two(d.getHours())}:${two(d.getMinutes())}`
  return new Date(now).toDateString() === d.toDateString() ? hm : `${DAYS[d.getDay()]} ${hm}`
}

/** A delay ahead: "45 min", "2h30", "3j 2h" */
const fmtIn = (ms: number) => {
  const m = Math.max(0, Math.round(ms / MIN))
  if (m < 60) return `${m} min`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h${two(m % 60)}`
  return `${Math.floor(h / 24)}j ${h % 24}h`
}

// --- where the output files are ----------------------------------------------

// Paths work on Linux, macOS and Windows: the separator follows the base.
const sepOf = (p: string) => (p.includes('\\') && !p.includes('/') ? '\\' : '/')
const join = (base: string, ...parts: string[]) =>
  [base.replace(/[\\/]+$/, ''), ...parts.map(p => p.replace(/^[\\/]+|[\\/]+$/g, ''))].join(sepOf(base))
const dirOf = (p: string) => p.slice(0, Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\')))

// Finds <tmp>/claude*/<project>/<session>/tasks without assuming the OS:
// every temp folder the environment names, every claude* folder in it.
async function tasksDir($: EngineInterface): Promise<string | null> {
  const sid = await $.session.id()
  if (dirCache?.sid === sid) return dirCache.dir
  // Each variable by its literal name, so the engine can list what is read.
  const found = [
    await $.env.get('CLAUDE_CODE_TMPDIR'),
    await $.env.get('TMPDIR'),
    await $.env.get('TEMP'),
    await $.env.get('TMP'),
    '/tmp',
  ]
  const bases = found.filter((v, i): v is string => !!v && found.indexOf(v) === i)
  for (const base of bases) {
    const tops = (await $.fs.list(base).catch(() => [])).filter(
      ent => ent.kind === 'dir' && ent.name.toLowerCase().startsWith('claude'),
    )
    for (const top of tops) {
      const root = join(base, top.name)
      const direct = join(root, sid, 'tasks')
      if (await $.fs.exists(direct)) {
        dirCache = { sid, dir: direct }
        return direct
      }
      for (const ent of await $.fs.list(root).catch(() => [])) {
        if (ent.kind !== 'dir') continue
        const dir = join(root, ent.name, sid, 'tasks')
        if (await $.fs.exists(dir)) {
          dirCache = { sid, dir }
          return dir
        }
      }
    }
  }
  return null
}

// --- pace ----------------------------------------------------------------------

/** Length of a rate-limit window; 0 for one without a fixed length (spend_limit). */
const windowMs = (kind: string) => (kind.startsWith('five_hour') ? 5 * HOUR : kind.startsWith('seven_day') ? 7 * DAY : 0)

/** How much of a window must have passed before its rate means something. */
const minSpan = (kind: string) => (kind.startsWith('five_hour') ? 10 * MIN : 2 * HOUR)

/** Which window a reading belongs to: its reset time, to 10 minutes. */
const winOf = (r: number) => Math.round(r / (10 * MIN))

const cleanHist = (v: unknown): Record<string, Sample[]> => {
  const out: Record<string, Sample[]> = {}
  if (v === null || typeof v !== 'object') return out
  for (const [k, arr] of Object.entries(v as Record<string, unknown>)) {
    if (!Array.isArray(arr)) continue
    out[k] = arr.filter(
      (x): x is Sample => Array.isArray(x) && x.length === 3 && x.every(n => typeof n === 'number' && Number.isFinite(n)),
    )
  }
  return out
}

/**
 * Two sets of readings as one, oldest first. Within a window the % only
 * rises, so an equal reading adds nothing and a lower one is stale (a
 * session that has not asked the API for a while).
 */
const mergeSamples = (a: Sample[], b: Sample[], since: number): Sample[] => {
  const all = [...a, ...b].filter(x => x[0] >= since).sort((x, y) => x[0] - y[0] || x[1] - y[1])
  const top = new Map<number, number>()
  const out: Sample[] = []
  for (const x of all) {
    const w = winOf(x[2])
    const max = top.get(w)
    if (max !== undefined && x[1] <= max) continue
    top.set(w, x[1])
    out.push(x)
  }
  return out.slice(-HIST_MAX)
}

/** Reads the shared history, merges this session's readings in, writes it back when they are new. */
async function syncHist($: EngineInterface, now: number) {
  histSyncedAt = now
  const stored = cleanHist(await $.store.get(HIST_KEY))
  const mine = hist ?? {}
  const out: Record<string, Sample[]> = {}
  for (const k of new Set([...Object.keys(stored), ...Object.keys(mine)])) {
    out[k] = mergeSamples(stored[k] ?? [], mine[k] ?? [], now - HIST_KEEP)
  }
  hist = out
  if (histDirty) {
    await $.store.set(HIST_KEY, out)
    histDirty = false
  }
}

/** Adds this session's new readings to the history and returns it. */
async function recordReadings($: EngineInterface, limits: Limit[], now: number) {
  if (!hist || now - histSyncedAt >= SYNC_MS) await syncHist($, now)
  const h = hist ?? {}
  for (const l of limits) {
    const r = l.resetsAt ? Date.parse(l.resetsAt) : NaN
    if (!windowMs(l.kind) || Number.isNaN(r)) continue
    const key = `${l.percent}@${r}`
    if (seen.get(l.kind) === key) continue
    seen.set(l.kind, key)
    h[l.kind] = mergeSamples(h[l.kind] ?? [], [[now, l.percent, r]], now - HIST_KEEP)
    histDirty = true
  }
  hist = h
  return h
}

/**
 * How fast a window fills: its average since it began, at 0 %, so the
 * whole window's use counts, not just the last hour.
 * Then when it reaches 100 % at that rate, or what it stands at on reset.
 */
const paceOf = (l: Limit, samples: Sample[], now: number): Pace | undefined => {
  const len = windowMs(l.kind)
  const reset = l.resetsAt ? Date.parse(l.resetsAt) : NaN
  if (!len || Number.isNaN(reset) || reset <= now) return undefined
  const start = reset - len
  const pts = samples.filter(x => winOf(x[2]) === winOf(reset) && x[0] >= start - 10 * MIN && x[0] <= now)
  // Another session may have read a higher % since this one's last request.
  const cur = Math.max(l.percent, ...pts.map(x => x[1]))
  const sustain = Math.max(0, (100 - cur) / ((reset - now) / HOUR))
  if (cur >= 100) return { rate: 0, sustain: 0, hitAt: now }

  const span = now - start
  if (span < minSpan(l.kind)) return { sustain }
  const rate = cur / (span / HOUR)
  const hit = rate > 0 ? now + ((100 - cur) / rate) * HOUR : Infinity
  const atReset = cur + (rate * (reset - now)) / HOUR
  return hit < reset
    ? { rate, span, sustain, hitAt: hit, over: atReset - 100 }
    : { rate, span, sustain, atReset: Math.min(100, atReset) }
}

/** Counts a model request's tokens: new input, cache writes and output; cache reads are left out. */
async function addTokens($: EngineInterface, n: number) {
  if (!(n > 0)) return
  const now = await $.clock.now()
  await update($, tokens, t => ({
    ...t,
    since: t.since || now,
    total: t.total + n,
  }))
}

// --- /usage ------------------------------------------------------------------
//
// The API reports two windows (5h, 7d all models); /usage also shows a
// model's own week ("Current week (Fable): 17% used · resets Nov 1,
// 8:59pm (UTC)"). A headless `claude -p /usage`, without plugins or a saved
// session, reads it; no model request is made.

const MONTHS_EN = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec']

/** "Nov 1, 8:59pm (UTC)" → ms; the year is the one that puts it nearest ahead. */
const parseResets = (text: string, now: number): number | undefined => {
  const m = /([A-Za-z]{3})[a-z]*\.? (\d{1,2}),? (\d{1,2})(?::(\d{2}))? ?([ap]m)?\s*(?:\(([^)]+)\))?/i.exec(text)
  if (!m) return undefined
  const mon = MONTHS_EN.indexOf((m[1] ?? '').toLowerCase())
  if (mon < 0) return undefined
  const day = Number(m[2])
  let hour = Number(m[3])
  const ap = (m[5] ?? '').toLowerCase()
  if (ap === 'pm' && hour < 12) hour += 12
  if (ap === 'am' && hour === 12) hour = 0
  const min = Number(m[4] ?? 0)
  // The CLI prints in this machine's zone, or says UTC.
  const at = (y: number) =>
    m[6] === 'UTC' ? Date.UTC(y, mon, day, hour, min) : new Date(y, mon, day, hour, min).getTime()
  const year = new Date(now).getFullYear()
  const t = at(year)
  return t < now - 30 * DAY ? at(year + 1) : t
}

/** The model-specific weeks /usage lists, as limits `seven_day_<model>`. */
const parseUsage = (text: string, now: number): Limit[] => {
  const out: Limit[] = []
  for (const m of text.matchAll(/^Current week \(([^)]+)\):\s*(\d+(?:\.\d+)?)% used(?:\s*·\s*resets (.+))?$/gim)) {
    const name = (m[1] ?? '').trim().toLowerCase()
    if (!name || name === 'all models') continue
    const reset = m[3] ? parseResets(m[3], now) : undefined
    out.push(
      clean({
        kind: `seven_day_${name.replace(/[^a-z0-9]+/g, '_')}`,
        percent: Number(m[2]),
        resetsAt: reset !== undefined ? new Date(reset).toISOString() : undefined,
      }),
    )
  }
  return out
}

/** Reads /usage in the background, at most every USAGE_POLL. */
async function pollUsage($: EngineInterface, now: number) {
  if (usagePolling || now - usagePolledAt < USAGE_POLL) return
  usagePolling = true
  usagePolledAt = now
  try {
    const r = await $.process.run(['claude', '-p', '--safe-mode', '--no-session-persistence', '/usage'], {
      timeoutMs: 30_000,
    })
    if (r.exitCode === 0) extraLimits = parseUsage(r.stdout, now)
  } catch (err) {
    if (!usageFailed) $.ui.log(`shell-watch: /usage: ${String(err)}`)
    usageFailed = true
  } finally {
    usagePolling = false
  }
}

// --- usage -------------------------------------------------------------------

async function refreshUsage($: EngineInterface) {
  const now = await $.clock.now()
  const u = await $.session.usage()
  // Right after the read: the requests it already counts are the ones queued.
  takeCost(u.cost?.usd, now)
  const reported: Limit[] = u.rateLimits.map(l => clean({ kind: l.kind, percent: l.percentUsed, resetsAt: l.resetsAt }))
  // Off the tick: the CLI takes a few seconds.
  if (reported.length > 0) void pollUsage($, now)
  const limits = [...reported, ...extraLimits.filter(x => !reported.some(l => l.kind === x.kind))]
  // The history is a bonus: a store that fails leaves the meters and shells alone.
  const h = await recordReadings($, limits, now).catch((err: unknown) => {
    if (!histFailed) $.ui.log(`shell-watch: pace history: ${String(err)}`)
    histFailed = true
    return hist ?? {}
  })
  const pace: Record<string, Pace> = {}
  for (const l of limits) {
    const p = paceOf(l, h[l.kind] ?? [], now)
    if (p) pace[l.kind] = clean(p)
  }
  const prev = await read($, usage)
  const model = await $.session.model().catch(() => '')
  const next: Usage = {
    at: now,
    startedAt: u.startedAt,
    model: model || prev.model,
    effort: stepEffort ?? prev.effort,
    ctxPercent: u.context.percent,
    ctxTokens: u.context.tokens,
    ctxWindow: u.context.window,
    usd: u.cost?.usd,
    limits,
    pace,
  }
  await update($, usage, () => clean(next))
}

// --- project: cost and time ------------------------------------------------------
//
// Work is someone at it: the person (a signal under AWAY_MS old: typing,
// sending, answering a permission, a click in the pane, the session opening)
// or the model (a turn under way, even one waiting on its shell, or a
// subagent's). Claude waiting on a permission or a question is not at work;
// a background shell or a timer alone is not either. AWAY_MS without either:
// the count stops and the gap counts AWAY_KEEP.

const AWAY_MS = 5 * MIN
const AWAY_KEEP = 3 * MIN
// Ticks further apart than this: the machine slept, the gap is not counted.
const ASLEEP_MS = 2 * MIN
const PROJ_SYNC_MS = 60_000
const COMPACT_MS = HOUR

type Proj = {
  root: string
  /** `proj-1|<root>|` */
  prefix: string
  /** this process's key */
  key: string
  pid: string
  days: Record<string, ProjDay>
  /** the last days by the hour */
  hours: Record<string, ProjDay>
  /** the session counted in `run`, and its total in this process */
  sid: string
  run: ProjDay
  dirty: boolean
  syncedAt: number
  compactedAt: number
  archive: Archive
  /** the other processes' records, by key */
  others: Map<string, { pid: string; rec: ProcRec }>
  /** the archive and the other processes, merged by day: all but this process */
  base: Map<string, ProjDay>
  /** the repository's files (other machines, an earlier clone) that this machine's store does not hold, by day */
  imported: Map<string, ProjDay>
  /** each file of the repository's folder as last read: its size and time, its entries */
  gitFiles: Map<string, { size: number; mtimeMs: number; entries: GitEntry[] }>
}
let proj: Proj | null = null
// This machine's id: its file's name in each repository. Kept in $.store.
const MACHINE_KEY = 'machine-1'
let machineId = ''
let projFailed = false

// The session's cost as last shared out, and the responses since, waiting for
// the next reading of the total.
let costBase: number | undefined
type Step = { model: string; w: number; input: number; cacheWrite: number; cacheRead: number; output: number }
const steps: Step[] = []
let lastModel = ''

// Who is at work.
let signaled = false
let activeAt = 0
let tickAt = 0
let away = false
// Work counted since the last activity, per hour: what an absence takes back.
const gap = new Map<string, number>()
// Loops in a turn: '' for the main one, a subagent's id; and the calls waiting
// on a person, with their loop.
const loops = new Set<string>()
const asks = new Map<string, string>()

const isWorking = () => {
  const waiting = new Set(asks.values())
  for (const l of loops) if (!waiting.has(l)) return true
  return false
}

/** A sign that the person is there. */
const signal = () => {
  signaled = true
}

/** A call a person was asked about went on (allowed or refused): they answered. */
const answered = (id: string | undefined) => {
  if (id && asks.delete(id)) signal()
}

/** The records a moment counts in: its day, its hour, the session. */
const recsAt = (p: Proj, now: number) => [(p.days[dayKey(now)] ??= emptyDay()), (p.hours[hourKey(now)] ??= emptyDay()), p.run]

/**
 * Shares the rise of the session's cost between the responses that ended
 * since the last reading, by their weight, each to its model. A total that
 * went down (/clear) is the new base. A rise with no response (a mod's model
 * call) waits for the next one, or goes to the last model at the end.
 */
function takeCost(usd: number | undefined, now: number, final = false) {
  if (!proj || usd === undefined) {
    // Nowhere to count them: they do not wait.
    steps.length = 0
    return
  }
  if (costBase === undefined || usd < costBase) costBase = usd
  const delta = usd - costBase
  const done = steps.splice(0)
  if (done.length === 0) {
    if (!final || !(delta > 0) || !lastModel) return
    done.push({ model: lastModel, w: 1, input: 0, cacheWrite: 0, cacheRead: 0, output: 0 })
  }
  costBase = usd
  const recs = recsAt(proj, now)
  const total = done.reduce((s, x) => s + x.w, 0)
  for (const s of done) {
    const share = total > 0 ? (delta * s.w) / total : delta / done.length
    for (const rec of recs) {
      const m = (rec.models[s.model] ??= emptyModel())
      m.usd += share
      m.input += s.input
      m.cacheWrite += s.cacheWrite
      m.cacheRead += s.cacheRead
      m.output += s.output
      rec.usd += share
    }
  }
  proj.dirty = true
}

/** One tick of the clocks: open time, and work time by the rule above. */
function accountTime(now: number) {
  const p = proj
  if (!p) return
  const dt = tickAt ? now - tickAt : 0
  tickAt = now
  const active = signaled || isWorking()
  signaled = false
  if (active) {
    activeAt = now
    away = false
    gap.clear()
  }
  if (dt <= 0 || dt > ASLEEP_MS) return
  const recs = recsAt(p, now)
  for (const rec of recs) rec.open += dt
  p.dirty = true
  if (away) return
  if (now - activeAt >= AWAY_MS) {
    away = true
    // The gap counts AWAY_KEEP: the rest comes off its hours, latest first,
    // their days and the session; days before yesterday are closed (archived)
    // and stay as they are.
    let over = [...gap.values()].reduce((s, x) => s + x, 0) - AWAY_KEEP
    const yesterday = dayShift(now, -1)
    for (const [h, ms] of [...gap].reverse()) {
      const d = p.days[h.slice(0, 10)]
      const hr = p.hours[h]
      if (over <= 0 || h.slice(0, 10) < yesterday || !d || !hr) continue
      const cut = Math.min(over, ms, d.work, hr.work)
      d.work -= cut
      hr.work -= cut
      p.run.work = Math.max(0, p.run.work - cut)
      over -= cut
    }
    gap.clear()
    return
  }
  for (const rec of recs) rec.work += dt
  if (!active) {
    const h = hourKey(now)
    gap.set(h, (gap.get(h) ?? 0) + dt)
  }
}

const procKey = (prefix: string, pid: string) => `${prefix}p|${pid}`

/** Writes this process's record, reads the others', compacts now and then. */
async function syncProject($: EngineInterface, now: number) {
  const p = proj
  if (!p) return
  p.syncedAt = now
  if (p.dirty) {
    p.dirty = false
    p.hours = keptHours(p.hours, now)
    const round = (r: Record<string, ProjDay>) => Object.fromEntries(Object.entries(r).map(([k, d]) => [k, roundDay(d)]))
    await $.store.set(p.key, { at: now, days: round(p.days), hours: round(p.hours), sid: p.sid, run: roundDay(p.run) })
  }
  const keys = (await $.store.keys()).filter(k => k.startsWith(`${p.prefix}p|`) && k !== p.key)
  p.archive = toArchive(await $.store.get(`${p.prefix}a`))
  p.others = new Map()
  for (const k of keys) p.others.set(k, { pid: k.slice(p.prefix.length + 2), rec: toProc(await $.store.get(k)) })
  if (now - p.compactedAt >= COMPACT_MS) await compact($, p, now)
  p.base = mergeDays(
    p.archive,
    [...p.others.values()].map(o => [o.pid, o.rec.days] as const),
  )
  // The repository's files are a bonus: one that fails leaves the rest alone.
  await readGitFiles($, p).catch(() => undefined)
  p.imported = entryDays(foreignEntries(localOf(p), [...p.gitFiles.values()].map(f => f.entries)))
}

/** What this machine's store holds for the project: the archive, every process (this one as it stands). */
const localOf = (p: Proj) =>
  localEntries(p.archive, [[p.pid, p.days] as const, ...[...p.others.values()].map(o => [o.pid, o.rec.days] as const)])

const gitPath = (p: Proj, name?: string) => (name ? join(p.root, GIT_DIR, name) : join(p.root, GIT_DIR))

/** Reads the repository's folder, each file again only when it changed. */
async function readGitFiles($: EngineInterface, p: Proj) {
  const list = (await $.fs.list(gitPath(p)).catch(() => [])).filter(f => f.kind === 'file' && f.name.endsWith('.json'))
  const next = new Map<string, { size: number; mtimeMs: number; entries: GitEntry[] }>()
  for (const f of list) {
    const had = p.gitFiles.get(f.name)
    if (had && had.size === f.size && had.mtimeMs === f.mtimeMs) {
      next.set(f.name, had)
      continue
    }
    const text = await $.fs.read(gitPath(p, f.name)).catch(() => '')
    let entries: GitEntry[] = []
    try {
      entries = toGitEntries(JSON.parse(text))
    } catch {
      // a file cut mid-merge: none of its entries until it reads again
    }
    next.set(f.name, { size: f.size, mtimeMs: f.mtimeMs, entries })
  }
  p.gitFiles = next
}

async function ensureMachine($: EngineInterface) {
  if (machineId) return machineId
  const stored = await $.store.get(MACHINE_KEY)
  if (typeof stored === 'string' && /^[a-z0-9]{6,}$/.test(stored)) return (machineId = stored)
  const made = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`
  await $.store.set(MACHINE_KEY, made)
  return (machineId = made)
}

// Whether the project's folder is in a git work tree, per folder.
const inGit = new Map<string, boolean>()

/**
 * Before a commit Claude runs: writes this machine's file in the repository
 * and stages it, so the commit carries the project's records.
 */
async function exportGit($: EngineInterface) {
  const p = proj
  if (!p) return
  let isRepo = inGit.get(p.root)
  if (isRepo === undefined) {
    const r = await $.process.run(['git', 'rev-parse', '--is-inside-work-tree'], { cwd: p.root, timeoutMs: 5000 })
    isRepo = r.exitCode === 0 && r.stdout.trim() === 'true'
    inGit.set(p.root, isRepo)
  }
  if (!isRepo) return
  const now = await $.clock.now()
  p.dirty = true
  await syncProject($, now)
  const machine = await ensureMachine($)
  const name = `${machine}.json`
  const file = gitPath(p, name)
  const before = await $.fs.read(file).catch(() => '')
  let previous: GitEntry[] = []
  try {
    previous = before ? toGitEntries(JSON.parse(before)) : []
  } catch {
    previous = []
  }
  const text = gitFileText(machine, localOf(p), previous)
  if (text !== before) await $.fs.write(file, text)
  // Ignored by the repository (.gitignore): it stays out, as asked.
  await $.process.run(['git', 'add', '--', `${GIT_DIR}/${name}`], { cwd: p.root, timeoutMs: 10_000 })
}

// A commit in a Bash command: `git commit`, `git -C dir commit`, `git -c k=v commit`.
const GIT_COMMIT = /\bgit(?:\s+-[Cc]\s+(?:"[^"]*"|'[^']*'|\S+)|\s+--?[\w-]+(?:=\S+)?)*\s+commit(?![\w-])/

/** Moves closed days into the archive; drops or deletes those it already holds. */
async function compact($: EngineInterface, p: Proj, now: number) {
  p.compactedAt = now
  const plan = planCompaction(now, p.archive, { pid: p.pid, days: p.days }, p.others)
  for (const day of plan.drop) {
    delete p.days[day]
    p.dirty = true
  }
  for (const k of plan.remove) {
    await $.store.delete(k)
    p.others.delete(k)
  }
  if (plan.merge.length > 0) {
    const fresh = mergeArchive(toArchive(await $.store.get(`${p.prefix}a`)), plan.merge)
    await $.store.set(`${p.prefix}a`, roundArchive(fresh))
    p.archive = fresh
  }
}

/** Every day of the project, every process summed, this one as it stands now. */
const projectDays = (p: Proj) => {
  const out = new Map<string, ProjDay>()
  for (const [day, rec] of p.base) {
    const d = emptyDay()
    addInto(d, rec)
    out.set(day, d)
  }
  const add = (day: string, rec: ProjDay) => {
    let d = out.get(day)
    if (!d) out.set(day, (d = emptyDay()))
    addInto(d, rec)
  }
  for (const [day, rec] of Object.entries(p.days)) if (!p.archive.days[day]?.from.includes(p.pid)) add(day, rec)
  for (const [day, rec] of p.imported) add(day, rec)
  return out
}

async function initProject($: EngineInterface) {
  const root = await $.session.root()
  if (!root) return
  let pid = await read($, proc)
  if (!pid) {
    const made = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`
    pid = made
    await update($, proc, () => made)
  }
  const prefix = `proj-1|${root}|`
  const key = procKey(prefix, pid)
  const sid = await $.session.id()
  if (proj?.key === key) {
    // A new session in this process (/clear): its total starts from zero.
    if (proj.sid !== sid) {
      proj.sid = sid
      proj.run = emptyDay()
      proj.dirty = true
    }
    return
  }
  // A reload (or a session resumed in this process) goes on from what it wrote.
  const mine = toProc(await $.store.get(key))
  proj = {
    root,
    prefix,
    key,
    pid,
    days: mine.days,
    hours: mine.hours,
    sid,
    run: mine.sid === sid ? mine.run : emptyDay(),
    dirty: mine.sid !== sid,
    syncedAt: 0,
    compactedAt: 0,
    archive: { days: {} },
    others: new Map(),
    base: new Map(),
    imported: new Map(),
    gitFiles: new Map(),
  }
  // What the session cost before (a resume, a reload) is not this project's new work.
  costBase = (await $.session.usage().catch(() => null))?.cost?.usd
  signal()
  const now = await $.clock.now()
  await syncProject($, now)
  await publishProject($, now)
}

async function publishProject($: EngineInterface, now: number) {
  const p = proj
  if (!p) return
  const days = projectDays(p)
  const others = [...p.others.values()].map(o => o.rec)
  // The current session: this process's, and the others' that count for it (a restart).
  const session = emptyDay()
  addInto(session, p.run)
  for (const r of others) if (r.sid && r.sid === p.sid) addInto(session, r.run)
  // The 7-day window began 7 days before its reset; without it, the last 7 days.
  const lim = (await read($, usage)).limits
  const seven = lim.find(l => l.kind === 'seven_day') ?? lim.find(l => l.kind.startsWith('seven_day'))
  const reset = seven?.resetsAt ? Date.parse(seven.resetsAt) : NaN
  const weekReset = Number.isFinite(reset)
  const start = !weekReset ? now - 7 * DAY : reset <= now ? reset : reset - 7 * DAY
  const view: ProjectView = {
    root: p.root,
    session,
    week: sumSince(start, days, [p.hours, ...others.map(r => r.hours)]),
    weekReset,
    total: sumDays(days),
    since: firstDay(days),
  }
  await update($, projectView, () => view)
}

/** A work time: "0m", "45m", "1h20", "152h05". */
const fmtWork = (ms: number) => {
  const m = Math.max(0, Math.floor(ms / MIN))
  return m < 60 ? `${m}m` : `${Math.floor(m / 60)}h${two(m % 60)}`
}

const money = (usd: number) => `$${usd.toFixed(2)}`

/** $ per hour, once there is enough time for it to mean something. */
const perHour = (usd: number, ms: number) => (ms >= 5 * MIN ? fr(usd / (ms / HOUR), 2) : '–')

/** A model's part of a span's cost: "83%", "<1%"; '' without a cost. */
const pctOf = (part: number, whole: number) => {
  if (!(whole > 0)) return ''
  const pct = (part / whole) * 100
  return part > 0 && pct < 0.5 ? '<1%' : `${Math.round(pct)}%`
}

/** "jeu. 30 oct. 2026" for a day key; '' for none. */
const sinceLabel = (day: string) => (day ? fmtDate(dayTime(day)) : '')

/** A span's models by name (ids of one model merged), most costly first. */
const byModel = (d: ProjDay) => {
  const out = new Map<string, ProjDay['models'][string]>()
  for (const [id, m] of Object.entries(d.models)) {
    const name = prettyModel(id)
    const t = out.get(name) ?? emptyModel()
    t.usd += m.usd
    t.input += m.input
    t.cacheWrite += m.cacheWrite
    t.cacheRead += m.cacheRead
    t.output += m.output
    out.set(name, t)
  }
  return [...out].sort((a, b) => b[1].usd - a[1].usd)
}

/** A row of the table: cost, work time and its $/h (the time open is not a measure of work). */
type ProjRow = { label: string; usd: string; work: string; workRate: string }
const PROJ_COLS = ['usd', 'work', 'workRate'] as const
const projRow = (label: string, d: ProjDay): ProjRow => ({
  label,
  usd: money(d.usd),
  work: fmtWork(d.work),
  workRate: perHour(d.usd, d.work),
})
const projHead = (label: string): ProjRow => ({
  label,
  usd: 'coût',
  work: 'travail',
  workRate: '$/h',
})
const colWidths = (rows: ProjRow[]) => ({
  label: Math.max(0, ...rows.map(r => r.label.length)),
  ...(Object.fromEntries(PROJ_COLS.map(k => [k, Math.max(0, ...rows.map(r => r[k].length))])) as Record<
    (typeof PROJ_COLS)[number],
    number
  >),
})

const tilde = (root: string) => root.replace(/^\/home\/[^/]+/, '~').replace(/^[A-Za-z]:\\Users\\[^\\]+/i, '~')

/** "mer. 18 nov.", with the year when it is not this one. */
const dayLabel = (key: string, now: number) => {
  const d = new Date(dayTime(key))
  const year = d.getFullYear() !== new Date(now).getFullYear() ? ` ${d.getFullYear()}` : ''
  return `${DAYS[d.getDay()]} ${d.getDate()} ${MONTHS[d.getMonth()]}${year}`
}

/** /couts: the project's days, latest first, each with its models and their four kinds of tokens. */
async function coutsText($: EngineInterface) {
  const p = proj
  if (!p) return 'shell-watch : pas de projet pour cette session.'
  const now = await $.clock.now()
  await syncProject($, now)
  const days = projectDays(p)
  const keys = [...days.keys()].sort().reverse()
  const name = p.root.split(/[\\/]/).filter(Boolean).pop() ?? p.root
  const since = sinceLabel(firstDay(days))
  const out = [
    `Projet ${name} (${tilde(p.root)}), toutes ses sessions.`,
    ...(since ? [`Commencé le ${since}.`] : []),
    ...(p.imported.size > 0 ? [`Avec les autres ordinateurs : ce que leurs commits ont mis dans ${GIT_DIR}/.`] : []),
    "Coût : estimation en équivalent API (le prix de l'API), pas la facture de l'abonnement.",
    '',
  ]
  if (keys.length === 0) return [...out, "Rien de compté pour l'instant."].join('\n')
  const total = sumDays(days)
  const rows = [projHead('jour'), ...keys.map(k => projRow(dayLabel(k, now), days.get(k) ?? emptyDay())), projRow('total', total)]
  const w = colWidths(rows)
  w.label = Math.max(w.label, ...[...days.values(), total].flatMap(d => byModel(d).map(([n]) => n.length + 2)))
  const line = (r: ProjRow) => [r.label.padEnd(w.label), ...PROJ_COLS.map(k => r[k].padStart(w[k]))].join('  ').trimEnd()
  const models = (d: ProjDay) =>
    byModel(d).map(([n, m]) =>
      [
        `  ${n}`.padEnd(w.label),
        money(m.usd).padStart(w.usd),
        pctOf(m.usd, d.usd).padStart(4),
        `${perHour(m.usd, d.work)} $/h`,
        `entrée ${fmtTok(m.input)} · écriture cache ${fmtTok(m.cacheWrite)} · lecture cache ${fmtTok(m.cacheRead)} · sortie ${fmtTok(m.output)}`,
      ].join('  '),
    )
  out.push(line(rows[0] as ProjRow))
  keys.forEach((k, i) => {
    out.push(line(rows[i + 1] as ProjRow), ...models(days.get(k) ?? emptyDay()))
  })
  out.push('', line(rows[rows.length - 1] as ProjRow), ...models(total))
  return out.join('\n')
}

async function tickProject($: EngineInterface) {
  if (!proj) return
  const now = await $.clock.now()
  accountTime(now)
  if (now - proj.syncedAt >= PROJ_SYNC_MS) await syncProject($, now)
  await publishProject($, now)
}

// --- tailing -----------------------------------------------------------------

async function readTail($: EngineInterface, file: string): Promise<string[] | null> {
  const st = await $.fs.stat(file).catch(() => null)
  if (!st || st.kind !== 'file') return null
  if (sizes.get(file) === st.size) return null
  sizes.set(file, st.size)
  if (st.size === 0) return []
  if (st.size > BIG_FILE) {
    // `tail` where the system has it (Linux, macOS); a whole read elsewhere.
    const ran = await $.process
      .run(['tail', '-c', String(BIG_FILE / 4), file], { timeoutMs: 2000 })
      .catch(() => null)
    if (ran && ran.exitCode === 0) return lastLines(ran.stdout)
    if (st.size > 16 * 1024 * 1024) return null
    return lastLines((await $.fs.read(file)).slice(-BIG_FILE / 4))
  }
  return lastLines(await $.fs.read(file))
}

async function tick($: EngineInterface) {
  if (busy) return
  busy = true
  try {
    // The usage first (it shares out the cost), then the Projet section's
    // clocks, which go on even when the usage could not be read.
    const failed = await refreshUsage($).then(
      () => null,
      (err: unknown) => ({ err }),
    )
    await tickProject($).catch((err: unknown) => {
      if (!projFailed) $.ui.log(`shell-watch: project: ${String(err)}`)
      projFailed = true
    })
    if (failed) throw failed.err
    await refreshAgents($).catch(() => undefined)
    const list = await read($, shells)
    const live = list.filter(isLive)
    if (live.length === 0) return

    const patch = new Map<string, Partial<Shell>>()

    // Give each running shell without a file the newest unclaimed one that
    // appeared after it started.
    const orphans = live.filter(s => !s.file).sort((a, b) => a.startedAt - b.startedAt)
    if (orphans.length > 0) {
      const dir = await tasksDir($)
      if (dir) {
        const claimed = new Set(list.map(s => s.file).filter((f): f is string => !!f))
        const entries = (await $.fs.list(dir).catch(() => [])).filter(
          f => f.kind === 'file' && f.name.endsWith('.output'),
        )
        for (const s of orphans) {
          const pick = entries
            .filter(f => !claimed.has(join(dir, f.name)) && f.mtimeMs >= s.startedAt - 2000)
            .sort((a, b) => a.mtimeMs - b.mtimeMs)[0]
          if (!pick) continue
          const file = join(dir, pick.name)
          claimed.add(file)
          patch.set(s.id, { file })
        }
      }
    }

    for (const s of live) {
      const file = patch.get(s.id)?.file ?? s.file
      if (!file) continue
      const tail = await readTail($, file).catch(() => null)
      if (tail !== null) patch.set(s.id, { ...patch.get(s.id), file, tail })
    }

    if (patch.size > 0) {
      await putShells($, cur =>
        cur.map(s => {
          const p = patch.get(s.id)
          return p && isLive(s) ? { ...s, ...p } : s
        }),
      )
    }
  } finally {
    busy = false
  }
}

function ensureTimer($: EngineInterface) {
  if (timer) return
  timer = $.clock.every(TICK_MS, () => {
    void tick($).catch(() => {
      busy = false
    })
  })
}

// --- tool results --------------------------------------------------------------

const asRecord = (v: unknown): Record<string, unknown> | null =>
  v !== null && typeof v === 'object' ? (v as Record<string, unknown>) : null

const str = (v: unknown) => (typeof v === 'string' ? v : '')

async function finish($: EngineInterface, id: string, ran: unknown) {
  const now = await $.clock.now()
  const r = asRecord(ran) ?? {}
  const patchOf = async (s: Shell): Promise<Shell> => {
    if (typeof r.deny === 'string') {
      return { ...s, status: 'failed', endedAt: now, file: undefined, tail: [`refusé : ${r.deny}`] }
    }
    const res = asRecord(r.result)
    const text = str(r.text)
    const taskId = res ? str(res.backgroundTaskId) : ''
    if (taskId) {
      const fromText = /written to:\s*(.+?\.output)/.exec(text)?.[1]
      const dir = fromText ? dirOf(fromText) : await tasksDir($)
      return { ...s, status: 'background', taskId, file: fromText ?? (dir ? join(dir, `${taskId}.output`) : s.file) }
    }
    let out = res ? [str(res.stdout), str(res.stderr)].filter(Boolean).join('\n') : str(r.result)
    if (!out) out = text
    const status: ShellStatus = res?.interrupted === true ? 'interrupted' : r.isError === true ? 'failed' : 'done'
    const code = /exit code (\d+)/i.exec(text || out)?.[1]
    const exitCode = code !== undefined ? Number(code) : status === 'done' ? 0 : undefined
    if (s.file) sizes.delete(s.file)
    return { ...s, status, exitCode, endedAt: now, file: undefined, tail: out ? lastLines(out) : s.tail }
  }
  const list = await read($, shells)
  const cur = list.find(s => s.id === id)
  if (!cur) return
  const done = await patchOf(cur)
  await putShells($, l => l.map(s => (s.id === id ? done : s)))
}

// A background task's end reaches the session as a <task-notification> row.
async function onNotification($: EngineInterface, text: string) {
  if (!text.includes('<task-notification>')) return
  const toolUseId = /<tool-use-id>([^<]+)<\/tool-use-id>/.exec(text)?.[1]
  const taskId = /<task-id>([^<]+)<\/task-id>/.exec(text)?.[1]
  const status = /<status>([^<]+)<\/status>/.exec(text)?.[1] ?? ''
  const exit = /exit code (\d+)/.exec(text)?.[1]
  const ok = status === 'completed' && (exit === undefined || exit === '0')
  const list = await read($, shells)
  const s = list.find(x => (toolUseId && x.id === toolUseId) || (taskId && x.taskId === taskId))
  if (!s || s.status !== 'background') return
  const tail = s.file ? await (sizes.delete(s.file), readTail($, s.file)).catch(() => null) : null
  const now = await $.clock.now()
  await putShells($, l =>
    l.map(x =>
      x.id === s.id
        ? {
            ...x,
            status: ok ? 'bg-done' : 'bg-failed',
            exitCode: exit !== undefined ? Number(exit) : undefined,
            endedAt: now,
            tail: tail ?? x.tail,
          }
        : x,
    ),
  )
}

// --- agents ----------------------------------------------------------------------

const AGENT_DONE: readonly AgentRunStatus[] = ['completed', 'failed', 'killed']
const isAgentLive = (a: AgentRun) => !AGENT_DONE.includes(a.status)

const putAgents = ($: EngineInterface, fn: (list: AgentRun[]) => AgentRun[]) =>
  update($, agents, list => fn(list).map(clean))

/** A tool call in a few words: "Bash · npm test", "Read · register.tsx". */
const activityOf = (e: Record<string, unknown>) => {
  const tool = str(e.tool)
  const get = (k: string) => (str(e[k]).split('\n')[0] ?? '').trim()
  const base = (path: string) => path.split(/[\\/]/).pop() ?? path
  const what =
    tool === 'Bash'
      ? get('description') || get('command')
      : tool === 'Read' || tool === 'Edit' || tool === 'Write' || tool === 'NotebookEdit'
        ? base(get('file_path') || get('notebook_path'))
        : tool === 'Grep' || tool === 'Glob'
          ? get('pattern')
          : tool === 'WebFetch'
            ? get('url')
            : tool === 'WebSearch'
              ? get('query')
              : tool === 'Agent'
                ? get('description')
                : ''
  return what ? `${tool} · ${what}` : tool
}

/** Brings the running agents' status up to date from the engine's list. */
async function refreshAgents($: EngineInterface) {
  const list = await read($, agents)
  if (!list.some(isAgentLive)) return
  const infos = new Map((await $.agent.list()).map(i => [i.id, i]))
  const now = await $.clock.now()
  const next = new Map<string, AgentRunStatus>()
  for (const a of list) {
    if (!isAgentLive(a)) continue
    // An agent the engine no longer lists has ended.
    const status = infos.get(a.id)?.status ?? (now - a.startedAt > 5000 ? 'completed' : a.status)
    if (status !== a.status) next.set(a.id, status)
  }
  if (next.size === 0) return
  await putAgents($, cur =>
    cur.map(a => {
      const status = next.get(a.id)
      if (!status || !isAgentLive(a)) return a
      return { ...a, status, endedAt: AGENT_DONE.includes(status) ? now : undefined }
    }),
  )
}

// --- a sound when Claude is done ---------------------------------------------------
//
// The end of a main-loop turn that was not interrupted plays the system's own
// notification sound. $.audio.play plays nothing in a Windows or Linux
// terminal: the system's player does it, by `$.process.run`. /son switches it.

const SOUND_KEY = 'sound-1'
let soundOn: boolean | null = null
let sysname = ''

const WIN_SOUND = "(New-Object Media.SoundPlayer (Join-Path $env:WINDIR 'Media/Windows Notify System Generic.wav')).PlaySync()"

async function isSoundOn($: EngineInterface) {
  if (soundOn === null) soundOn = (await $.store.get(SOUND_KEY)) !== false
  return soundOn
}

async function playDone($: EngineInterface) {
  if (!(await isSoundOn($))) return
  if (!sysname) sysname = (await $.session.machine().catch(() => null))?.sysname ?? '?'
  const argv =
    sysname === 'Windows_NT'
      ? ['powershell', '-NoProfile', '-NonInteractive', '-Command', WIN_SOUND]
      : sysname === 'Darwin'
        ? ['afplay', '/System/Library/Sounds/Glass.aiff']
        : ['paplay', '/usr/share/sounds/freedesktop/stereo/complete.oga']
  await $.process.run(argv, { timeoutMs: 10_000 }).catch(() => undefined)
}

// --- the module -----------------------------------------------------------------

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'shells',
      description: 'Open the live shells & subscription usage pane',
    })
    await $.command.register({
      name: 'son',
      description: 'Switch the sound played when Claude is done (on / off)',
    })
    await $.command.register({
      name: 'couts',
      description: "This project's cost and work time, day by day and per model (estimate at API prices)",
    })
    ensureTimer($)
    // Folded sections stay folded from one session to the next.
    await safe($, async () => {
      const v = await $.store.get(FOLD_KEY)
      if (Array.isArray(v)) await update($, folded, () => v.filter((x): x is Section => SECTIONS.includes(x)))
    })
    await safe($, () => initProject($))
    // A new session id (startup, /clear, resume) counts its tokens from zero.
    await safe($, async () => {
      const sid = await $.session.id()
      const now = await $.clock.now()
      await update($, tokens, t => (t.sid === sid ? t : { sid, since: now, total: 0 }))
    })
    // No status-line entry any more: clear the one an earlier version left.
    $.ui.status(undefined)
    void $.ui.open({ id: PANE, title: TITLE, backgroundColor: C.base })
    return next(e)
  })

  on('session.end', async ($, e, next) => {
    timer?.cancel()
    timer = null
    if (histDirty) await safe($, async () => syncHist($, await $.clock.now()))
    // The last of the cost and the time, written before the process goes.
    await safe($, async () => {
      if (!proj) return
      const now = await $.clock.now()
      takeCost((await $.session.usage()).cost?.usd, now, true)
      accountTime(now)
      proj.dirty = true
      await syncProject($, now)
    })
    return next(e)
  })

  on('command.run', { command: 'couts' }, async $ => {
    signal()
    const text = await coutsText($).catch((err: unknown) => `shell-watch : ${String(err)}`)
    return { text, isTextDisplayOnly: true }
  })

  on('command.run', { command: 'son' }, async $ => {
    signal()
    const next = !(await isSoundOn($))
    soundOn = next
    await $.store.set(SOUND_KEY, next)
    if (next) void playDone($)
    return { text: next ? 'Son de fin de travail : activé.' : 'Son de fin de travail : coupé.', isTextDisplayOnly: true }
  })

  on('command.run', { command: 'shells' }, async $ => {
    signal()
    ensureTimer($)
    await $.ui.open({ id: PANE, title: TITLE, focus: true, backgroundColor: C.base })
    return { text: 'Shells pane opened.' }
  })

  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    const id = e.tool_use_id
    // The project's records go with each commit Claude makes.
    if (GIT_COMMIT.test(e.command)) await safe($, () => exportGit($))
    await safe($, async () => {
      ensureTimer($)
      const now = await $.clock.now()
      const shell: Shell = {
        id,
        command: e.command,
        description: e.description,
        agent: e.agentId,
        startedAt: now,
        status: 'running',
        tail: [],
      }
      await putShells($, list => [...list.filter(s => s.id !== id), shell].slice(-MAX_SHELLS))
    })
    const ran = await next(e)
    await safe($, () => finish($, id, ran))
    return ran
  }).catch(($, e, next) => next(e))

  // A subagent starting: what it was asked, its type and model.
  on('agent.spawn', async ($, e, next) => {
    const r = await next(e)
    const id = r.agentId
    if (id) {
      await safe($, async () => {
        ensureTimer($)
        const now = await $.clock.now()
        const run: AgentRun = {
          id,
          description: e.description,
          type: e.subagentType,
          model: r.model,
          background: e.background,
          parentId: e.parentAgentId,
          startedAt: now,
          status: 'running',
          tools: 0,
          tokens: 0,
        }
        await putAgents($, list => [...list.filter(a => a.id !== id), run].slice(-MAX_AGENTS))
      })
    }
    return r
  }).catch(($, e, next) => next(e))

  // Each tool call a subagent makes: counted, and shown as its last activity.
  on('tool.call', async ($, e, next) => {
    const id = e.agentId
    if (id) {
      const last = activityOf(e as unknown as Record<string, unknown>)
      await safe($, () => putAgents($, list => list.map(a => (a.id === id ? { ...a, tools: a.tools + 1, last } : a))))
    }
    try {
      return await next(e)
    } finally {
      // Refused by the person: the call ends without running.
      answered(e.tool_use_id)
    }
  }).catch(($, e, next) => next(e))

  // A call put to a person: its loop waits on them until they answer.
  on('tool.check', async ($, e, next) => {
    const r = await next(e)
    if (r.decision === 'ask' && e.approver === 'person' && e.tool_use_id) asks.set(e.tool_use_id, e.agentId ?? '')
    return r
  })

  // Auto mode's classifier settled it: nobody was asked.
  on('tool.judge', async ($, e, next) => {
    const r = await next(e)
    if (r.decision !== 'ask') asks.delete(e.tool_use_id)
    return r
  })

  // Allowed: the person said yes (when they were asked).
  on('tool.run', ($, e, next) => {
    answered(e.tool_use_id)
    return next(e)
  })

  // A loop at work from its turn's start to its end: the main one, a subagent's.
  on('turn.start', ($, e, next) => {
    loops.add(e.agentId ?? '')
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    try {
      return await next(e)
    } finally {
      const l = e.agentId ?? ''
      loops.delete(l)
      for (const [id, of] of asks) if (of === l) asks.delete(id)
      // Claude is done: a sound, off the hook (the player takes a moment).
      if (e.agentId === undefined && !e.isAborted) void playDone($).catch(() => undefined)
    }
  })

  // The person at the prompt: typing, a recalled entry, sending.
  on('prompt.edit', ($, e, next) => {
    signal()
    return next(e)
  })

  on('prompt.change', ($, e, next) => {
    signal()
    return next(e)
  })

  on('prompt.submit', ($, e, next) => {
    signal()
    return next(e)
  })

  // Each model request of the main loop says which effort it asks for, and
  // each response (subagents' too) how many tokens it used.
  // Pass-through: the stream is forwarded untouched.
  on('turn.step', async function* ($, e, next) {
    if (e.agentId === undefined && e.effort !== undefined) stepEffort = String(e.effort)
    const agentId = e.agentId
    if (agentId !== undefined && e.effort !== undefined) {
      const effort = String(e.effort)
      await safe($, () =>
        putAgents($, list => list.map(a => (a.id === agentId && a.effort !== effort ? { ...a, effort } : a))),
      )
    }
    const r = yield* next(e)
    const t = r.usage
    if (t) {
      // Its $ come with the next reading of the session's total (takeCost).
      const model = t.model || e.model
      lastModel = model
      steps.push({
        model,
        w: stepWeight(t),
        input: t.input_tokens,
        cacheWrite: t.cache_creation_input_tokens,
        cacheRead: t.cache_read_input_tokens,
        output: t.output_tokens,
      })
      const n = t.input_tokens + t.cache_creation_input_tokens + t.output_tokens
      await safe($, () => addTokens($, n))
      const id = e.agentId
      if (id) await safe($, () => putAgents($, list => list.map(a => (a.id === id ? { ...a, tokens: a.tokens + n } : a))))
    }
    return r
  })

  on('session.append', async ($, e, next) => {
    const stored = await next(e)
    if (e.message.type === 'user') {
      const text = e.message.content
        .map(b => (b.type === 'text' ? b.text : ''))
        .join('\n')
      if (text.includes('<task-notification>')) void safe($, () => onNotification($, text))
    }
    return stored
  }).catch(($, e, next) => next(e))

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const u = await read($, usage)
    const list = await read($, shells)
    const open = await read($, expanded)
    const view = await read($, filter)
    const tok = await read($, tokens)
    const runs = await read($, agents)
    const pv = await read($, projectView)
    const shut = await read($, folded)
    const width = Math.max(30, (e.props.bodyColumns || e.viewport?.columns || 80) - 2)
    const inner = width - 2
    const now = u.at || Date.now()
    // One line per window: label, bar, %, then what is left at the reset at
    // this pace and when the reset is; columns line up from one window to the next.
    // Too narrow for that: the bar keeps the reset ("reset dans 2j 15h
    // (dim. 21:00)", 30 columns) and what is left goes on a second line.
    // A few spaces set the reset (and ctx's tokens) apart from the %.
    const GAP = '   '
    const cells = u.limits.map(l => limitCells(l, u.pace?.[l.kind], now))
    const wLeft = Math.max(0, ...cells.map(c => c.left.length))
    const wTail = Math.max(0, ...cells.map(c => limitTail(c, wLeft).length))
    // label 7 + bar + space + "100%" 4, then the rest, 2 spaces apart
    const lineW = 12 + (wTail ? 2 + wTail : 0)
    const oneLine = inner - lineW >= 8
    const barW = oneLine ? Math.min(20, inner - lineW) : Math.max(8, Math.min(28, inner - 44 - GAP.length))
    // Tokens per minute over the session (cache reads left out).
    const tokAvg = tok.since && now - tok.since >= MIN ? tok.total / ((now - tok.since) / MIN) : undefined

    // The project's folder, in full.
    const root = await $.session.root().catch(() => '')

    // A click in the pane is a sign the person is there.
    const press = (fn: () => unknown) => async () => {
      signal()
      await fn()
    }

    // A section's title folds it and unfolds it (▾ open, ▸ folded); a folded
    // section keeps its title and a short summary.
    const isShut = (k: Section) => shut.includes(k)
    const toggle = (k: Section) =>
      press(async () => {
        const next = isShut(k) ? shut.filter(x => x !== k) : [...shut, k]
        await update($, folded, () => next)
        await $.store.set(FOLD_KEY, next).catch(() => undefined)
      })
    const sectionTitle = (k: Section, title: string, note?: string, noteColor: string = C.dim) => (
      <Button key={`fold-${k}`} plain onPress={toggle(k)}>
        <Text>
          <Text color={C.accent} bold>{`${isShut(k) ? '▸' : '▾'} ${title}`}</Text>
          {note ? <Text color={noteColor}>{`  ${note}`}</Text> : ''}
        </Text>
      </Button>
    )

    const live = list.filter(isLive).sort((a, b) => a.startedAt - b.startedAt)
    const ended = list.filter(s => !isLive(s)).sort((a, b) => (b.endedAt ?? 0) - (a.endedAt ?? 0))

    // A spinner that turns once a second while a shell is still open.
    const spin = '◐◓◑◒'[Math.floor(now / 1000) % 4] ?? '●'

    // The state pill: colored background, dark text, fixed width.
    const pill = (s: Shell) =>
      s.status === 'running'
        ? { glyph: spin, label: 'EN COURS', color: C.accent }
        : s.status === 'background'
          ? { glyph: spin, label: 'EN FOND', color: C.text }
          : s.status === 'done' || s.status === 'bg-done'
            ? { glyph: '✓', label: 'TERMINÉ', color: C.mint }
            : s.status === 'interrupted'
              ? { glyph: '■', label: 'STOPPÉ', color: C.orange }
              : { glyph: '✗', label: 'ÉCHEC', color: C.red }

    const clock = (ms: number) => {
      const d = new Date(ms)
      return `${two(d.getHours())}:${two(d.getMinutes())}:${two(d.getSeconds())}`
    }

    const meter = (label: string, pct: number, color: string, note?: string) => {
      const b = barParts(pct, barW)
      return (
        <Text key={`m-${label}`}>
          <Text color={C.sub}>{label.padEnd(7)}</Text>
          <Text color={color}>{b.on}</Text>
          <Text color={C.track}>{b.off}</Text>
          <Text color={C.text} bold>
            {' '}
            {`${Math.round(pct)}%`.padStart(4)}
          </Text>
          {note ? <Text color={C.dim}> {note}</Text> : ''}
        </Text>
      )
    }

    // A window's bar: red from 80 %, orange when less than 10 % would be
    // left at the reset at this pace (or it runs out first), mint otherwise.
    const limitLevel = (l: Limit) => {
      if (l.percent >= 80) return C.red
      const p = u.pace?.[l.kind]
      if (!p || p.rate === undefined) return C.mint
      const left = p.hitAt !== undefined ? 0 : 100 - Math.round(p.atReset ?? 0)
      return left < 10 ? C.accent : C.mint
    }

    // After the bar, at this pace: what is left at the reset, in mint; or, in
    // red, how far past 100 % it goes. Then when the reset is, unless `withReset` is off.
    const leftTag = (c: Cells, wl = 0, withReset = true) => {
      const text = limitTail(withReset ? c : { ...c, reset: '' }, wl)
      if (!text) return ''
      const lead = c.left ? `${c.left.padStart(wl)}` : ' '.repeat(wl ? wl + 4 : 0)
      return (
        <Text>
          {c.left ? <Text color={c.hit ? C.red : C.mint} bold>{`  ${lead}`}</Text> : <Text>{`  ${lead}`}</Text>}
          {/* VS Code lifts any grey under its minimum contrast: sub, a step lighter */}
          <Text color={c.hit ? C.red : C.sub}>{c.left ? ' au reset' : 'reset'}</Text>
          {withReset && c.reset ? <Text color={C.dim}>{` ${c.reset}`}</Text> : ''}
        </Text>
      )
    }

    // The whole window on one line, its cells padded to the widest of the windows.
    const limitLine = (l: Limit, c: Cells) => {
      const b = barParts(l.percent, barW)
      return (
        <Text key={`lim-${l.kind}`}>
          <Text color={C.sub}>{kindLabel(l.kind).padEnd(7)}</Text>
          <Text color={limitLevel(l)}>{b.on}</Text>
          <Text color={C.track}>{b.off}</Text>
          <Text color={C.text} bold>
            {' '}
            {`${Math.round(l.percent)}%`.padStart(4)}
          </Text>
          {leftTag(c, wLeft)}
        </Text>
      )
    }

    const row = (s: Shell, lines: number) => {
      const p = pill(s)
      const took = fmtDur((s.endedAt ?? now) - s.startedAt)
      const cmd = (s.command.split('\n')[0] ?? '').trim()
      const isOpen = isLive(s) || open === s.id
      const shown = isOpen ? s.tail.slice(-lines) : []
      const isBg = s.status === 'background' || s.status.startsWith('bg-')
      // glyph 3 + space + "hh:mm:ss → hh:mm:ss" 19 + space
      const room = inner - 24 - (isBg ? 3 : 0) - (s.agent ? 6 : 0)
      const cut = (t: string, n: number) => (t.length > n ? `${t.slice(0, Math.max(1, n - 1))}…` : t)
      // The title says why the shell was launched: the call's description,
      // or the command itself when there is none.
      const title = s.description?.trim() || cmd
      return (
        <Box key={s.id} flexDirection="column" marginBottom={1}>
          <Button
            key={`row-${s.id}`}
            plain
            onPress={press(() => update($, expanded, cur => (cur === s.id ? null : s.id)))}
          >
            <Text color={p.color} bold>{` ${p.glyph} `}</Text>{' '}
            <Text color={C.sub}>{clock(s.startedAt)}</Text>
            <Text color={C.dim}> → </Text>
            {s.endedAt !== undefined ? (
              <Text color={C.sub}>{clock(s.endedAt)}</Text>
            ) : (
              <Text color={p.color}>{`+${took}`.padEnd(8)}</Text>
            )}{' '}
            {isBg ? <Text color={C.sub}>bg </Text> : ''}
            {s.agent ? <Text color={C.sub}>agent </Text> : ''}
            <Text color={isOpen ? C.accent : s.status === 'done' || s.status === 'bg-done' ? C.textSoft : C.text} bold>
              {cut(title, Math.max(8, room))}
            </Text>
          </Button>
          {isOpen ? (
            <Text color={C.dim} wrap="truncate-end">
              {'   durée '}
              <Text color={C.sub}>{took}</Text>
              {s.exitCode !== undefined ? (
                <Text color={s.exitCode === 0 ? C.mint : C.red}>{` · code ${s.exitCode}`}</Text>
              ) : (
                ''
              )}
              {s.description ? ` · $ ${cut(cmd, Math.max(8, inner - 30 - took.length))}` : ''}
            </Text>
          ) : null}
          {isOpen ? (
            <Box flexDirection="column" backgroundColor={C.term} marginLeft={2} paddingX={1}>
              {shown.length === 0 ? (
                <Text color={C.dim}>{isLive(s) ? '(pas encore de sortie)' : '(aucune sortie)'}</Text>
              ) : (
                shown.map((l, i) => (
                  <Text key={`${s.id}-${i}`} color={ERROR_LINE.test(l) ? C.red : C.sub} wrap="truncate-end">
                    {l || ' '}
                  </Text>
                ))
              )}
            </Box>
          ) : null}
        </Box>
      )
    }

    // Projet: the session, since the 7-day window's reset, all of it; each with
    // its cost, its work time and $/h, then its models: $ and their part of the
    // $/h (they add up to the span's). The tokens are in /couts.
    const projectCard = () => {
      if (!pv.root) return null
      const t = pv.total
      if (isShut('project'))
        return (
          <Box flexDirection="column" backgroundColor={C.card} paddingX={1} marginBottom={1}>
            {sectionTitle('project', 'Projet', `${money(t.usd)} · ${perHour(t.usd, t.work)} $/h travail`)}
          </Box>
        )
      // A model's line ends with its part of the span's cost.
      type Line = { label: string; usd: string; work: string; rate: string; pct: string }
      const rate = (usd: number, ms: number) => {
        const r = perHour(usd, ms)
        return r === '–' ? r : `${r} $/h`
      }
      const spans: [string, ProjDay][] = [
        ['séance', pv.session],
        [pv.weekReset ? 'depuis ↻ 7j' : '7 derniers j', pv.week],
        ['total', t],
      ]
      const blocks = spans.map(([label, d]) => ({
        head: { label, usd: money(d.usd), work: fmtWork(d.work), rate: rate(d.usd, d.work), pct: '' } as Line,
        models: byModel(d).map(
          ([name, m]): Line => ({
            label: `  ${name}`,
            usd: money(m.usd),
            work: '',
            rate: rate(m.usd, d.work),
            pct: pctOf(m.usd, d.usd),
          }),
        ),
      }))
      const all = blocks.flatMap(b => [b.head, ...b.models])
      const w = (k: keyof Line) => Math.max(0, ...all.map(r => r[k].length))
      const line = (r: Line, key: string, head: boolean) => (
        <Text key={key} wrap="truncate-end">
          <Text color={head ? C.text : C.accent} bold={head}>
            {r.label.padEnd(w('label'))}
          </Text>
          <Text color={head ? C.accent : C.text} bold={head}>{`  ${r.usd.padStart(w('usd'))}`}</Text>
          <Text color={C.text}>{`  ${r.work.padStart(w('work'))}`}</Text>
          <Text color={C.sub}>{`  ${r.rate.padStart(w('rate'))}`}</Text>
          {r.pct ? <Text color={C.text}>{`  ${r.pct.padStart(w('pct'))}`}</Text> : ''}
        </Text>
      )
      return (
        <Box flexDirection="column" backgroundColor={C.card} paddingX={1} paddingY={1} marginBottom={1}>
          {sectionTitle(
            'project',
            'Projet',
            `${pv.since ? `commencé le ${sinceLabel(pv.since)} · ` : ''}coût estimé au prix de l'API`,
          )}
          {blocks.flatMap((b, i) => [
            <Text key={`proj-gap-${i}`}> </Text>,
            line(b.head, `proj-${i}`, true),
            ...b.models.map((m, j) => line(m, `proj-${i}-${j}`, false)),
          ])}
        </Box>
      )
    }

    return (
      <Box flexDirection="column" flexGrow={1} backgroundColor={C.base} paddingX={1} paddingY={1}>
        {/* the date and time on the left; on the right the folder, the model and
            its effort, each its own color; the session's age under them */}
        <Box flexDirection="column" marginBottom={1}>
          <Box flexDirection="row" justifyContent="space-between">
            <Box flexShrink={0}>
              <Text>
                <Text color={C.sub}>{fmtDate(now)}</Text>
                <Text color={C.dim}>{'  ·  '}</Text>
                <Text color={C.text} bold>
                  {clock(now)}
                </Text>
              </Text>
            </Box>
            <Box flexShrink={1} marginLeft={2}>
              <Text wrap="truncate-start">
                {root ? (
                  <Text color={C.accent} bold>
                    {root}
                  </Text>
                ) : (
                  ''
                )}
                {u.model ? (
                  <Text color={C.mint} bold>
                    {`  ${prettyModel(u.model)}`}
                  </Text>
                ) : (
                  ''
                )}
                {u.effort ? (
                  <Text>
                    <Text color={C.lilac}>{`  ${'▰'.repeat(EFFORT[u.effort]?.level ?? 0)}`}</Text>
                    <Text color={C.track}>{'▰'.repeat(EFFORT[u.effort] ? 5 - (EFFORT[u.effort]?.level ?? 0) : 0)}</Text>
                    <Text color={C.lilac}> {EFFORT[u.effort]?.label ?? u.effort}</Text>
                  </Text>
                ) : (
                  <Text color={C.dim}>{'  effort ?'}</Text>
                )}
              </Text>
            </Box>
          </Box>
          {u.startedAt ? (
            <Text color={C.dim}>
              {'session depuis '}
              <Text color={C.sub} bold>
                {fmtSince(now - u.startedAt)}
              </Text>
              {` (ouverte à ${clockHM(u.startedAt)})`}
            </Text>
          ) : null}
        </Box>
        <Box flexDirection="column" backgroundColor={C.card} paddingX={1} paddingY={isShut('usage') ? 0 : 1} marginBottom={1}>
          {sectionTitle(
            'usage',
            'Abonnement',
            isShut('usage') ? u.limits.map(l => `${kindLabel(l.kind)} ${Math.round(l.percent)}%`).join(' · ') : undefined,
          )}
          {/* one blank line between every block, to breathe; the windows stay together */}
          {isShut('usage') ? null : [
            u.limits.length === 0 ? (
              <Text key="no-limits" color={C.dim}>Limites inconnues (attend la prochaine réponse de l'API)</Text>
            ) : (
              <Box key="limits" flexDirection="column">
                {u.limits.map((l, i) =>
                  oneLine ? (
                    limitLine(l, cells[i] as Cells)
                  ) : (
                    // the bar and its reset, then the pace on a line of its own
                    <Box key={`lim-${l.kind}`} flexDirection="column">
                      {meter(kindLabel(l.kind), l.percent, limitLevel(l), GAP + fmtReset(l.resetsAt, now))}
                      {(cells[i] as Cells).left ? (
                        <Text>
                          <Text>{' '.repeat(5)}</Text>
                          {leftTag(cells[i] as Cells, 0, false)}
                        </Text>
                      ) : null}
                    </Box>
                  ),
                )}
              </Box>
            ),
            ...(u.ctxPercent !== undefined
              ? [
                  // an extra blank line sets the limits apart from the session's figures
                  <Box key="ctx" flexDirection="column">
                    <Text> </Text>
                    {meter(
                      'ctx',
                      u.ctxPercent,
                      u.ctxPercent >= 50 ? level(u.ctxPercent) : C.text,
                      `${GAP}${u.ctxTokens !== undefined ? fmtTokens(u.ctxTokens) : '?'} / ${u.ctxWindow ? fmtTokens(u.ctxWindow) : '?'}`,
                    )}
                  </Box>,
                ]
              : []),
            ...(u.usd !== undefined
              ? [
                  <Text key="cost">
                    <Text color={C.sub}>{'coût'.padEnd(7)}</Text>
                    <Text color={C.accent} bold>
                      ${u.usd.toFixed(2)}
                    </Text>
                    {u.startedAt && now - u.startedAt >= 5 * MIN ? (
                      <Text color={C.dim}>{` · ${fr(u.usd / ((now - u.startedAt) / HOUR), 2)} $/h`}</Text>
                    ) : (
                      ''
                    )}
                    {tokAvg !== undefined ? <Text color={C.dim}>{` · ${fmtTok(tokAvg)} tok/min`}</Text> : ''}
                  </Text>,
                ]
              : []),
          ].flatMap((el, i) => [<Text key={`gap-${i}`}> </Text>, el])}
        </Box>

        {projectCard()}

        {(() => {
          // Shown once the session has started an agent; ended ones stay.
          const shown = runs
          if (shown.length === 0) return null
          const nLive = shown.filter(isAgentLive).length
          const nDone = shown.length - nLive
          // Running ones first (oldest first), then ended ones (latest first);
          // children under their parent.
          const roots = shown.filter(a => !a.parentId || !shown.some(b => b.id === a.parentId))
          const ordered: { a: AgentRun; depth: number }[] = []
          const walk = (a: AgentRun, depth: number) => {
            ordered.push({ a, depth })
            for (const c of shown.filter(b => b.parentId === a.id).sort((x, y) => x.startedAt - y.startedAt)) walk(c, depth + 1)
          }
          const liveRoots = roots.filter(isAgentLive).sort((x, y) => x.startedAt - y.startedAt)
          const doneRoots = roots.filter(a => !isAgentLive(a)).sort((x, y) => (y.endedAt ?? 0) - (x.endedAt ?? 0))
          for (const a of [...liveRoots, ...doneRoots]) walk(a, 0)
          const cut = (t: string, n: number) => (t.length > n ? `${t.slice(0, Math.max(1, n - 1))}…` : t)
          return (
            <Box flexDirection="column" backgroundColor={C.card} paddingX={1} paddingY={isShut('agents') ? 0 : 1} marginBottom={1}>
              <Box flexDirection="row" justifyContent="space-between">
                {sectionTitle(
                  'agents',
                  'Agents',
                  `${nLive > 0 ? `${nLive} en cours` : ''}${nLive > 0 && nDone > 0 ? ' · ' : ''}${nDone > 0 ? `${nDone} terminé${nDone > 1 ? 's' : ''}` : ''}`,
                )}
                {/* Once every agent has ended: clears the list, and the section with it. */}
                {nLive === 0 && !isShut('agents') ? (
                  <Button key="agents-clear" plain onPress={press(() => putAgents($, list => list.filter(isAgentLive)))}>
                    <Text color={C.dim}>x tout effacer</Text>
                  </Button>
                ) : null}
              </Box>
              {isShut('agents') ? null : ordered.map(({ a, depth }) => {
                const isOn = isAgentLive(a)
                const glyph = isOn ? spin : a.status === 'completed' ? '✓' : a.status === 'killed' ? '■' : '✗'
                const color = isOn
                  ? C.accent
                  : a.status === 'completed'
                    ? C.mint
                    : a.status === 'killed'
                      ? C.orange
                      : C.red
                const type = a.type === 'general-purpose' ? 'general' : (a.type.split(':').pop() ?? a.type)
                const meta = [
                  `${a.tools} outil${a.tools > 1 ? 's' : ''}`,
                  `${fmtTok(a.tokens)} tok`,
                  a.background ? 'bg' : '',
                ]
                  .filter(Boolean)
                  .join(' · ')
                // Model and effort first: "Haiku 4.5 high"
                const model = a.model ? prettyModel(a.model) : '?'
                const effort = a.effort ? (EFFORT[a.effort]?.label ?? a.effort) : ''
                const head = `${model}${effort ? ` ${effort}` : ''}`
                // Started → ended, or → +running time, as the shells show it.
                const when = `${clock(a.startedAt)} → ${a.endedAt !== undefined ? clock(a.endedAt) : `+${fmtDur(now - a.startedAt)}`}`
                const pad = '  '.repeat(depth)
                const room = Math.max(8, inner - pad.length - head.length - when.length - type.length - 11)
                const doing = a.status === 'waiting' ? 'en attente' : a.status === 'idle' ? 'inactif' : a.last
                return (
                  <Box key={`agent-${a.id}`} flexDirection="column" marginTop={1}>
                    <Box flexDirection="row">
                    <Box flexGrow={1} flexShrink={1}>
                    <Text wrap="truncate-end">
                      <Text color={color} bold>{`${pad} ${glyph} `}</Text>
                      <Text color={C.accent}>{model}</Text>
                      {effort ? <Text color={C.sub}>{` ${effort}`}</Text> : ''}
                      <Text color={C.sub}>{`  ${clock(a.startedAt)}`}</Text>
                      <Text color={C.dim}> → </Text>
                      {a.endedAt !== undefined ? (
                        <Text color={C.sub}>{clock(a.endedAt)}</Text>
                      ) : (
                        <Text color={color}>{`+${fmtDur(now - a.startedAt)}`}</Text>
                      )}
                      <Text>{'  '}</Text>
                      <Text color={isOn ? C.text : C.textSoft} bold>
                        {cut(a.description, room)}
                      </Text>
                      <Text color={C.sub}>{`  ${type}`}</Text>
                    </Text>
                    </Box>
                    {/* An ended agent can be taken off the list. */}
                    {!isOn ? (
                      <Button
                        key={`agent-rm-${a.id}`}
                        plain
                        onPress={press(() => putAgents($, list => list.filter(x => x.id !== a.id)))}
                      >
                        <Text color={C.dim}> x</Text>
                      </Button>
                    ) : null}
                    </Box>
                    <Text color={C.dim} wrap="truncate-end">
                      {`${pad}   ${a.endedAt !== undefined ? `${fmtDur(a.endedAt - a.startedAt)} · ` : ''}${meta}`}
                      {isOn && doing ? (
                        <Text color={a.status === 'waiting' ? C.accent : C.dim}>{`  ↳ ${doing}`}</Text>
                      ) : (
                        ''
                      )}
                    </Text>
                  </Box>
                )
              })}
            </Box>
          )
        })()}

        <Box flexDirection="column" backgroundColor={C.card} paddingX={1} paddingY={isShut('shells') ? 0 : 1}>
          {/* Title + counters; each counter filters the list, a second click shows all. */}
          <Box flexDirection="row" gap={2} flexWrap="wrap">
            {sectionTitle(
              'shells',
              'Shells',
              isShut('shells')
                ? `${list.length} commande${list.length > 1 ? 's' : ''}${live.length > 0 ? ` · ${live.length} en cours` : ''}`
                : undefined,
              live.length > 0 ? C.accent : C.dim,
            )}
            {isShut('shells') ? null : (
              [
                { key: 'all', label: 'tous', color: C.sub },
                { key: 'running', label: 'en cours', color: C.accent },
                { key: 'background', label: 'en fond', color: C.text },
                { key: 'success', label: 'réussis', color: C.mint },
                { key: 'error', label: 'en erreur', color: C.red },
                { key: 'stopped', label: 'stoppés', color: C.orange },
              ] as const
            ).map(f => ({ ...f, n: list.filter(s => matches(s, f.key)).length }))
            .map(c => {
              const isOn = view === c.key
              return (
                <Button
                  key={`filter-${c.key}`}
                  plain
                  onPress={press(() => update($, filter, cur => (cur === c.key || c.key === 'all' ? 'all' : c.key)))}
                >
                  <Text color={c.n > 0 || isOn ? c.color : C.dim} bold={isOn} underline={isOn}>
                    {`${c.n} ${c.label}`}
                  </Text>
                </Button>
              )
            })}
          </Box>
          {isShut('shells') ? null : <Text> </Text>}
          {isShut('shells') ? null : (() => {
            const liveShown = live.filter(s => matches(s, view))
            const endedShown = ended.filter(s => matches(s, view))
            const empty =
              view === 'all' ? "Aucune commande pour l'instant." : `Aucun shell ${FILTER_EMPTY[view]}.`
            return [
              ...(liveShown.length + endedShown.length === 0
                ? [
                    <Text key="empty" color={C.dim}>
                      {empty}
                    </Text>,
                  ]
                : []),
              ...liveShown.map(s => row(s, liveShown.length > 2 ? 6 : 12)),
              ...endedShown.slice(0, 50).map(s => row(s, 20)),
              ...(endedShown.length > 0
                ? [
                    <Text key="hint" color={C.dim} italic>
                      Clique une commande terminée pour voir sa sortie.
                    </Text>,
                  ]
                : []),
            ]
          })()}
        </Box>
      </Box>
    )
  })
}
