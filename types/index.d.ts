export type ShellStatus =
  | 'running'
  | 'done'
  | 'failed'
  | 'interrupted'
  | 'background'
  | 'bg-done'
  | 'bg-failed'

export type Shell = {
  /** tool_use_id of the Bash call */
  id: string
  command: string
  description?: string
  /** set when a subagent ran it */
  agent?: string
  startedAt: number
  endedAt?: number
  status: ShellStatus
  /** background task id */
  taskId?: string
  /** live output file being tailed */
  file?: string
  /** last lines of output */
  tail: string[]
  /** the command's exit code, when known */
  exitCode?: number
}

/** Which shells the list shows: all, foreground running, background running, succeeded, failed, interrupted. */
export type ShellFilter = 'all' | 'running' | 'background' | 'success' | 'error' | 'stopped'

export type Limit = { kind: string; percent: number; resetsAt?: string }

export type Usage = {
  at: number
  /** when the session began (launch, first launch if resumed, or last /clear) */
  startedAt?: number
  /** the session's model id (claude-opus-5-5, …) */
  model?: string
  /** effort of the last main-loop model request (low … max, or a number) */
  effort?: string
  ctxPercent?: number
  ctxTokens?: number
  ctxWindow?: number
  usd?: number
  limits: Limit[]
}

declare module 'claude-code' {
  interface PluginState {
    'shell-watch': {
      shells: Shaped<Shell[]>
      usage: Shaped<Usage>
      expanded: Shaped<string | null>
      filter: Shaped<ShellFilter>
    }
  }
}
