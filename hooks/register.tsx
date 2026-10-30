import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Limit, Shell, ShellFilter, ShellStatus, Usage } from '../types'
import { GLYPH_W, bigRows, mix } from './bigfont'

// shell-watch: a pane that streams the output of every Bash command Claude
// runs (foreground and background), plus subscription limits, context and
// cost. The same figures sit in the status line.
//
// Claude Code writes each running command's output to
// <tmp>/claude-<uid>/<project>/<session>/tasks/<id>.output; a timer tails
// those files. A foreground file is deleted when the command ends, so the
// final output comes from the tool result instead.

const PANE = 'shell-watch'
const TITLE = 'Shells & usage'
const MAX_SHELLS = 30
const TAIL_LINES = 60
const TICK_MS = 1000
const BIG_FILE = 256 * 1024

const shells = atom({ plugin: 'shell-watch', key: 'shells' } as const, [] as Shell[], { shape: 'shells-1' })
const usage = atom({ plugin: 'shell-watch', key: 'usage' } as const, { at: 0, limits: [] } as Usage, {
  shape: 'usage-1',
})
const expanded = atom({ plugin: 'shell-watch', key: 'expanded' } as const, null as string | null, {
  shape: 'expanded-1',
})
// filter-2: the six filters; a value stored by 0.4.0 ('live', 'closed') reads as 'all'.
const filter = atom({ plugin: 'shell-watch', key: 'filter' } as const, 'all' as ShellFilter, { shape: 'filter-2' })

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
  const d = new Date(t)
  const hm = `${two(d.getHours())}:${two(d.getMinutes())}`
  const left = t - now
  if (left <= 0) return 'reset imminent'
  if (left < 24 * 3600_000) return `reset ${hm} (dans ${fmtDur(left)})`
  return `reset ${DAYS[d.getDay()]} ${hm}`
}

const kindLabel = (kind: string) =>
  kind === 'five_hour'
    ? '5h'
    : kind === 'seven_day'
      ? '7j'
      : kind === 'spend_limit'
        ? 'budget'
        : kind.replace(/^seven_day_/, '7j ').replace(/^five_hour_/, '5h ').replace(/_/g, ' ')

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
} as const

const level = (pct: number) => (pct >= 80 ? C.red : pct >= 50 ? C.accent : C.mint)

const barParts = (pct: number, width: number) => {
  const full = Math.max(0, Math.min(width, Math.round((pct / 100) * width)))
  return { on: '━'.repeat(full), off: '━'.repeat(width - full) }
}

const fmtTokens = (n: number) =>
  n >= 1_000_000 ? `${+(n / 1_000_000).toFixed(1)}M` : n >= 1000 ? `${Math.round(n / 1000)}k` : String(n)

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

// --- usage -------------------------------------------------------------------

async function refreshUsage($: EngineInterface) {
  const u = await $.session.usage()
  const now = await $.clock.now()
  const limits: Limit[] = u.rateLimits.map(l => clean({ kind: l.kind, percent: l.percentUsed, resetsAt: l.resetsAt }))
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
  }
  await update($, usage, () => clean(next))
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
    await refreshUsage($)
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

// --- the module -----------------------------------------------------------------

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'shells',
      description: 'Open the live shells & subscription usage pane',
    })
    ensureTimer($)
    // No status-line entry any more: clear the one an earlier version left.
    $.ui.status(undefined)
    void $.ui.open({ id: PANE, title: TITLE, backgroundColor: C.base })
    return next(e)
  })

  on('session.end', async ($, e, next) => {
    timer?.cancel()
    timer = null
    return next(e)
  })

  on('command.run', { command: 'shells' }, async $ => {
    ensureTimer($)
    await $.ui.open({ id: PANE, title: TITLE, focus: true, backgroundColor: C.base })
    return { text: 'Shells pane opened.' }
  })

  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    const id = e.tool_use_id
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

  // Each model request of the main loop says which effort it asks for.
  // Pass-through: read the input, forward the stream untouched.
  on('turn.step', async function* ($, e, next) {
    if (e.agentId === undefined && e.effort !== undefined) stepEffort = String(e.effort)
    return yield* next(e)
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
    const width = Math.max(30, (e.props.bodyColumns || e.viewport?.columns || 80) - 2)
    const inner = width - 2
    const barW = Math.max(8, Math.min(28, inner - 36))
    const now = u.at || Date.now()

    // Project name in big letters, with a mauve → blue gradient.
    const root = await $.session.root().catch(() => '')
    const project = root.split(/[\\/]/).filter(Boolean).pop() ?? ''
    const fitsBig = project.length > 0 && project.length * (GLYPH_W + 1) - 1 <= inner
    const big = fitsBig ? bigRows(project) : []
    const shade = (i: number) => mix(C.accent, C.mint, project.length > 1 ? i / (project.length - 1) : 0)
    const home = root.replace(/^\/home\/[^/]+/, '~').replace(/^[A-Za-z]:\\Users\\[^\\]+/i, '~')

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

    const meter = (label: string, pct: number, color: string, note: string) => {
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
          <Text color={C.dim}> {note}</Text>
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
            onPress={() => update($, expanded, cur => (cur === s.id ? null : s.id))}
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

    return (
      <Box flexDirection="column" flexGrow={1} backgroundColor={C.base} paddingX={1} paddingY={1}>
        {project ? (
          <Box flexDirection="column" alignItems="center" marginBottom={1}>
            {fitsBig ? (
              big.map((cells, r) => (
                <Text key={`big-${r}`}>
                  {cells.map((cell, i) => (
                    <Text key={`big-${r}-${i}`} color={shade(i)}>
                      {i > 0 ? ' ' : ''}
                      {cell}
                    </Text>
                  ))}
                </Text>
              ))
            ) : (
              <Text color={C.accent} bold>
                {project.toUpperCase()}
              </Text>
            )}
            <Text color={C.dim}>
              {home}
              {u.startedAt ? (
                <Text>
                  {'  ·  session depuis '}
                  <Text color={C.sub} bold>
                    {fmtSince(now - u.startedAt)}
                  </Text>
                  {` (ouverte à ${clockHM(u.startedAt)})`}
                </Text>
              ) : (
                ''
              )}
            </Text>
            <Text> </Text>
            <Text>
              <Text color={C.sub}>{fmtDate(now)}</Text>
              <Text color={C.dim}>{'  ·  '}</Text>
              <Text color={C.text} bold>
                {clock(now)}
              </Text>
              {u.model ? (
                <Text>
                  <Text color={C.dim}>{'  ·  '}</Text>
                  <Text color={C.accent} bold>
                    {prettyModel(u.model)}
                  </Text>
                </Text>
              ) : (
                ''
              )}
              {u.effort ? (
                <Text>
                  <Text color={C.dim}>{'  ·  effort '}</Text>
                  <Text color={C.accent}>
                    {'▰'.repeat(EFFORT[u.effort]?.level ?? 0)}
                  </Text>
                  <Text color={C.track}>{'▰'.repeat(EFFORT[u.effort] ? 5 - (EFFORT[u.effort]?.level ?? 0) : 0)}</Text>
                  <Text color={C.sub}> {EFFORT[u.effort]?.label ?? u.effort}</Text>
                </Text>
              ) : (
                <Text color={C.dim}>{'  ·  effort ?'}</Text>
              )}
            </Text>
          </Box>
        ) : null}
        <Box flexDirection="column" backgroundColor={C.card} paddingX={1} paddingY={1} marginBottom={1}>
          <Text color={C.accent} bold>
            Abonnement
          </Text>
          {/* one blank line between every row, to breathe */}
          {[
            ...(u.limits.length === 0
              ? [<Text key="no-limits" color={C.dim}>Limites inconnues (attend la prochaine réponse de l'API)</Text>]
              : u.limits.map(l => meter(kindLabel(l.kind), l.percent, level(l.percent), fmtReset(l.resetsAt, now)))),
            ...(u.ctxPercent !== undefined
              ? [
                  meter(
                    'ctx',
                    u.ctxPercent,
                    u.ctxPercent >= 50 ? level(u.ctxPercent) : C.text,
                    `${u.ctxTokens !== undefined ? fmtTokens(u.ctxTokens) : '?'} / ${u.ctxWindow ? fmtTokens(u.ctxWindow) : '?'}`,
                  ),
                ]
              : []),
            ...(u.usd !== undefined
              ? [
                  <Text key="cost">
                    <Text color={C.sub}>{'coût'.padEnd(7)}</Text>
                    <Text color={C.accent} bold>
                      ${u.usd.toFixed(2)}
                    </Text>
                    <Text color={C.dim}> cette session (équivalent API)</Text>
                  </Text>,
                ]
              : []),
          ].flatMap((el, i) => [<Text key={`gap-${i}`}> </Text>, el])}
        </Box>

        <Box flexDirection="column" backgroundColor={C.card} paddingX={1} paddingY={1}>
          {/* Title + counters; each counter filters the list, a second click shows all. */}
          <Box flexDirection="row" gap={2} flexWrap="wrap">
            <Text color={C.accent} bold>
              Shells
            </Text>
            {(
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
                  onPress={() => update($, filter, cur => (cur === c.key || c.key === 'all' ? 'all' : c.key))}
                >
                  <Text color={c.n > 0 || isOn ? c.color : C.dim} bold={isOn} underline={isOn}>
                    {`${c.n} ${c.label}`}
                  </Text>
                </Button>
              )
            })}
          </Box>
          <Text> </Text>
          {(() => {
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
              ...endedShown.slice(0, 15).map(s => row(s, 20)),
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
