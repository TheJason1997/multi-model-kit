// org-switch: under the claude-org launcher, watch this org's rate-limit
// windows and move the session to another org when one fills: optionally
// compact, write the target org and the session id to the handoff file, exit.
// The launcher then resumes the same session id under the other org's own
// config directory (each org signed in with its own /login).
//
// The launcher tells the mod, by environment:
//   CLAUDE_ORG          the org this process runs under
//   CLAUDE_ORGS         every org it can start, comma-separated
//   CLAUDE_ORG_HANDOFF  the file to write `next=` / `session=` / `fresh=` / `reason=` to
//   CLAUDE_ORG_RESUMED  "1" when the launch already names a conversation
//   CLAUDE_ORG_CODEX_EXIT  Codex's exit code, set only on the launch that follows a Codex takeover
// and, from the person's own shell, CLAUDE_ORG_SOFT_PCT (default 80): from that
// window percentage on, the main loop thinks one level less (never below
// medium) and the org is marked as saving quota until its windows read low.
//
// When every org stays limited for more than 20 minutes, the repository holds a
// .handoff.md and its working tree is clean, the mod hands the time over to
// Codex: it writes `codex=1` and `until=<epoch seconds>` with the target org and
// session, and exits. The launcher runs Codex in the foreground in this same
// directory, waits for that time, and resumes this session; one runs at a time,
// so there is nothing to lock. Codex changes files and commits nothing; the
// resumed session is told so (CLAUDE_ORG_CODEX_EXIT) instead of "继续". Its
// changes leave the tree dirty, so the next limit does not hand over again.
//
// The strategy (`decide`) is a pure function; the engine calls stay in the
// handlers below it.
import type { EngineInterface as Engine, Register, SessionRateLimit } from 'claude-code'

export type WindowSeen = { percentUsed: number; resetsAt?: string }
/** One org's last reading, stored under `ledger:<org>`. */
export type Ledger = { seenAt: number; windows: Record<string, WindowSeen> }
/** A limit seen as a failed request with no window to explain it, stored under `block:<org>`. */
export type Block = { kind: 'all' | 'fable'; until: number }
/** This org is past the soft threshold, stored under `saving:<org>`. */
export type Saving = { since: number; softAt: number }
/** The model a limit moved the session off, stored under `downgrade`. */
export type Downgrade = { from: string }
export type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max'
export type OrgState = { ledger?: Ledger; block?: Block }
export type Why = 'window' | 'limit' | 'fable'
export type Situation = {
  now: number
  current: string
  orgs: string[]
  fable: boolean // the session runs a Fable model
  why: Why // a window reached the threshold, or a turn failed on a limit (Fable's alone or any)
  states: Record<string, OrgState>
  lastSwitchAt?: number
}
export type Decision =
  | { kind: 'stay' }
  | { kind: 'move'; org: string; model?: string; go: boolean } // org may be the current one: a model change in place
  | { kind: 'wait'; org: string; model?: string; at: number }

const THRESHOLD = 95
const SOFT_AT = 80 // default soft threshold; CLAUDE_ORG_SOFT_PCT overrides
const TAKEOVER_AFTER_MS = 20 * 60_000 // Codex takes over only when Claude is out for longer than this
const COMPACT_AT = 50 // context % from which a switch compacts first
const PROBE_MS = 30 * 60_000 // an unexplained limit holds the org off this long; a wait probes this often
const SWITCH_COOLDOWN_MS = 2 * 60_000
const DOWNGRADE_MODEL = 'claude-opus-5-5'
const CONTINUE_TEXT = '继续'
const COMPACT_RETRY_MS = 2000
const COMPACT_RETRIES = 150 // five minutes of "a turn is still running"
const NAME_RE = /^[a-z][a-z0-9_-]{0,31}$/

const isFable = (model: string) => /fable/i.test(model)
const LOWER: Partial<Record<Effort, Effort>> = { max: 'xhigh', xhigh: 'high', high: 'medium' }
/** One level less thinking, never below medium. */
export const lowerEffort = (e: Effort): Effort => LOWER[e] ?? e
const short = (kind: string) => (kind === 'five_hour' ? '5h' : kind === 'seven_day' ? '7d' : kind)

/**
 * When an org can next serve the model: now when nothing binds, else the
 * LATEST reset among its spent windows and any block, since every one must clear.
 */
export function availableAt(s: OrgState, fable: boolean, now: number): number {
  let at = now
  for (const w of Object.values(s.ledger?.windows ?? {})) {
    const t = w.resetsAt !== undefined ? Date.parse(w.resetsAt) : NaN
    if (w.percentUsed >= THRESHOLD && Number.isFinite(t) && t > at) at = t
  }
  const b = s.block
  if (b !== undefined && b.until > now && (b.kind === 'all' || fable)) at = Math.max(at, b.until)
  return at
}

/** A failed turn no window explains holds this org off for a while (only Fable when it was Fable's). */
export function unexplainedBlock(why: Why, s: OrgState, fable: boolean, now: number): Block | undefined {
  if (why === 'window' || availableAt(s, fable, now) > now) return undefined
  return { kind: why === 'fable' ? 'fable' : 'all', until: now + PROBE_MS }
}

/**
 * Another org that serves this model; else, on Fable, Opus on the first org that
 * serves it (this one first); else wait for the org that frees first. A window
 * near its end only moves to an org that is free: the turn still runs. Never
 * switch org again within two minutes of the last switch.
 */
export function decide(s: Situation): Decision {
  const { now, current, fable } = s
  const at = (org: string, f: boolean) => availableAt(s.states[org] ?? {}, f, now)
  const i = s.orgs.indexOf(current)
  const others = s.orgs.map((_, k) => s.orgs[(i + 1 + k) % s.orgs.length] as string).filter(o => o !== current)
  let d: Decision | undefined
  const free = others.find(o => at(o, fable) <= now)
  if (free !== undefined) d = { kind: 'move', org: free, go: s.why !== 'window' }
  else if (s.why === 'window') return { kind: 'stay' }
  else {
    const all = [current, ...others]
    const opus = fable ? all.find(o => at(o, false) <= now) : undefined
    if (opus !== undefined) d = { kind: 'move', org: opus, model: DOWNGRADE_MODEL, go: true }
    else {
      let best: { org: string; at: number; model?: string } | undefined
      for (const org of all) {
        const t = at(org, fable)
        if (best === undefined || t < best.at) best = { org, at: t }
        if (fable) {
          const o = at(org, false)
          if (o < best.at) best = { org, at: o, model: DOWNGRADE_MODEL }
        }
      }
      if (best === undefined) return { kind: 'stay' }
      return best.model === undefined ? { kind: 'wait', org: best.org, at: best.at } : { kind: 'wait', org: best.org, model: best.model, at: best.at }
    }
  }
  if (d.org !== current && s.lastSwitchAt !== undefined && now - s.lastSwitchAt < SWITCH_COOLDOWN_MS) {
    const due = s.lastSwitchAt + SWITCH_COOLDOWN_MS
    return d.model === undefined ? { kind: 'wait', org: d.org, at: due } : { kind: 'wait', org: d.org, model: d.model, at: due }
  }
  return d
}

// ---- the engine side ----

// Whether Codex may take over here. Exit codes name what is missing (CODEX_NOT_READY).
export const CODEX_READY_SH = `top=$(git rev-parse --show-toplevel 2> /dev/null) || exit 3
[ -f "$top/.handoff.md" ] || exit 4
s=$(git -C "$top" status --porcelain) && [ -z "$s" ] || exit 5
command -v codex > /dev/null 2>&1 || exit 6`
const CODEX_NOT_READY: Record<number, string> = {
  3: 'this directory is not in a git repository',
  4: 'the repository has no .handoff.md',
  5: 'the working tree has uncommitted changes',
  6: 'the codex command is not installed',
}

export const codexText = (rc: string) =>
  `刚才所有 org 额度用完期间，Codex 在这个工作目录里改过文件，但没有提交（Codex 退出码 ${rc}）。` +
  '请先看 git status、git diff 和 .codex-takeover-notes.md，审查后再决定提交还是撤销，然后继续。'

type Resume = { go: boolean; model?: string }

const env: { org?: string; orgs: string[]; handoff?: string; resumed: boolean; softAt: number; codexExit?: string } = { orgs: [], resumed: false, softAt: SOFT_AT }
let conversed = false // a prompt went in during this process: the session id now names a conversation
let handoffStarted = false
let lastLimits: readonly SessionRateLimit[] = []
let contextPct = 0
let waitId = 0 // bumps to cancel a pending wait
let waiting = false
let waitWhy: Why | undefined // what the pending wait reacts to
let saving = false // this org is past the soft threshold
let restoreId = 0 // bumps to cancel a pending return to Fable

const active = () => env.org !== undefined && env.handoff !== undefined
const shouldCompact = () => contextPct >= COMPACT_AT

async function loadEnv($: Engine): Promise<void> {
  const org = await $.env.get('CLAUDE_ORG')
  env.orgs = ((await $.env.get('CLAUDE_ORGS')) ?? '').split(',').filter(o => NAME_RE.test(o))
  env.org = org !== undefined && env.orgs.includes(org) ? org : undefined
  const handoff = await $.env.get('CLAUDE_ORG_HANDOFF')
  env.handoff = handoff !== undefined && handoff.startsWith('/') ? handoff : undefined
  env.resumed = (await $.env.get('CLAUDE_ORG_RESUMED')) === '1'
  const soft = Number((await $.env.get('CLAUDE_ORG_SOFT_PCT')) ?? '')
  env.softAt = Number.isInteger(soft) && soft > 0 && soft < THRESHOLD ? soft : SOFT_AT
  const rc = await $.env.get('CLAUDE_ORG_CODEX_EXIT')
  env.codexExit = rc !== undefined && /^[0-9]{1,3}$/.test(rc) ? rc : undefined
}

async function readState($: Engine, org: string): Promise<OrgState> {
  const l = await $.store.get(`ledger:${org}`)
  const b = await $.store.get(`block:${org}`)
  return {
    ledger: l !== null && typeof l === 'object' ? (l as Ledger) : undefined,
    block: b !== null && typeof b === 'object' ? (b as Block) : undefined,
  }
}

async function readStates($: Engine): Promise<Record<string, OrgState>> {
  const states: Record<string, OrgState> = {}
  for (const org of env.orgs) states[org] = await readState($, org)
  return states
}

async function writeLedger($: Engine, org: string, limits: readonly SessionRateLimit[]): Promise<void> {
  const windows: Record<string, WindowSeen> = {}
  for (const w of limits) windows[w.kind] = { percentUsed: w.percentUsed, resetsAt: w.resetsAt }
  await $.store.set(`ledger:${org}`, { seenAt: await $.clock.now(), windows } satisfies Ledger)
}

const statusText = (org: string, limits: readonly SessionRateLimit[]) =>
  [org, ...limits.map(w => `${short(w.kind)} ${Math.round(w.percentUsed)}%`), ...(saving ? ['省额度'] : [])].join(' · ')

/** Mark or clear saving mode from a fresh reading of this org's windows. */
async function updateSaving($: Engine, org: string, limits: readonly SessionRateLimit[]): Promise<void> {
  const want = limits.some(w => w.percentUsed >= env.softAt)
  if (want === saving) return
  saving = want
  if (want) await $.store.set(`saving:${org}`, { since: await $.clock.now(), softAt: env.softAt } satisfies Saving)
  else await $.store.delete(`saving:${org}`)
}

function fmtIn(ms: number): string {
  if (ms <= 0) return 'already'
  const m = Math.round(ms / 60000)
  return m < 60 ? `in ${m} min` : m < 2880 ? `in ${(m / 60).toFixed(1)} h` : `in ${Math.round(m / 1440)} d`
}

function fmtAgo(ms: number): string {
  const m = Math.round(ms / 60000)
  return m < 1 ? 'just now' : m < 60 ? `${m} min ago` : m < 2880 ? `${(m / 60).toFixed(1)} h ago` : `${Math.round(m / 1440)} d ago`
}

/** Starts the switch and returns the line to show. */
function startSwitch($: Engine, target: string, compact: boolean, reason: string, extra = ''): string {
  if (handoffStarted) return 'org-switch: a switch is already under way.'
  handoffStarted = true
  $.ui.toast(`org-switch: ${reason}. ${compact ? 'Compacting, then switching' : 'Switching'} to ${target}.`, { timeoutMs: 8000 })
  $.clock.after(0, () => { void runSwitch($, target, compact, reason, 0, extra) })
  return `org-switch: ${compact ? 'compacting, then ' : ''}exiting so this session resumes under ${target}.`
}

const EXIT_GRACE_MS = 5000

async function runSwitch($: Engine, target: string, compact: boolean, reason: string, attempt: number, extra: string): Promise<void> {
  if (compact) {
    try {
      await $.command.run({
        command: 'compact',
        args: `The session is moving to the "${target}" org (${reason}). Keep the task in progress, its current state and the exact next step.`,
      })
    } catch (err) {
      if (attempt < COMPACT_RETRIES) {
        $.clock.after(COMPACT_RETRY_MS, () => { void runSwitch($, target, compact, reason, attempt + 1, extra) })
        return
      }
      $.ui.toast(`org-switch: /compact never ran (${String(err)}); switching uncompacted.`, { timeoutMs: 8000 })
    }
  }
  const sid = await $.session.id()
  // A session nobody has written to yet has no transcript to resume: start fresh under the new org instead.
  const line = env.resumed || conversed ? `session=${sid}` : 'fresh=1'
  await $.fs.write(env.handoff as string, `next=${target}\n${line}\n${extra}reason=${reason.replace(/[\r\n]+/g, ' ')}\n`)
  $.ui.toast(`org-switch: exiting; resuming ${sid.slice(0, 8)} under ${target}.`, { timeoutMs: 8000 })
  // The engine's own rate-limit dialog can hold /exit until a person answers it. Nobody may be there:
  // if this process is still alive after the grace, end it. The launcher resumes the session either way.
  $.clock.after(EXIT_GRACE_MS, () => { void $.process.run(['sh', '-c', 'kill -TERM "$PPID"']) })
  try {
    await $.command.run({ command: 'exit' })
  } catch (err) {
    $.ui.log(`org-switch: /exit refused (${String(err)}); sending SIGTERM to the engine`, { to: 'debug' })
    await $.process.run(['sh', '-c', 'kill -TERM "$PPID"'])
  }
}

const sendContinue = ($: Engine) => $.prompt.submit({ text: CONTINUE_TEXT })

/** Carry out a move: a model change (and "继续") here, or a switch to another org that resumes the same way. */
async function moveTo($: Engine, org: string, model: string | undefined, go: boolean, reason: string): Promise<void> {
  const was = await $.session.model()
  if (model === DOWNGRADE_MODEL && isFable(was)) await $.store.set('downgrade', { from: was } satisfies Downgrade)
  if (org === env.org) {
    if (model !== undefined && was !== model) {
      await $.command.run({ command: 'model', args: model })
      $.ui.toast(`org-switch: ${reason}; now on ${model}.`, { timeoutMs: 8000 })
    }
    if (go) await sendContinue($)
    await restoreFable($)
    return
  }
  await $.store.set('lastSwitchAt', await $.clock.now())
  // The other org's process starts on its own default model: carry this one over.
  // A session nobody has written to starts fresh under the other org: there is nothing to resume, so nothing to record.
  if (env.resumed || conversed) await $.store.set(`resume:${await $.session.id()}`, { go, model: model ?? was } satisfies Resume)
  startSwitch($, org, shouldCompact(), reason)
}

/** Wait for `org` to clear, looking again every PROBE_MS in case a limit lifted early. The timer only decides again. */
function waitFor($: Engine, d: { org: string; model?: string; at: number }, now: number, why: Why, detail: string): void {
  waiting = true
  waitWhy = why
  const id = ++waitId
  const due = Math.min(d.at, now + PROBE_MS)
  const isDue = due >= d.at
  $.ui.toast(
    `org-switch: every org is limited. ${d.org}${d.model ? ` (${d.model})` : ''} frees ${fmtIn(d.at - now)}; ${isDue ? 'continuing then' : `retrying in ${Math.round((due - now) / 60000)} min for a reset`}.`,
    { timeoutMs: 15000 },
  )
  $.clock.after(Math.max(0, due - now) + 5000, () => {
    if (id !== waitId) return
    waiting = false
    void react($, why, detail, !isDue)
  })
}

/**
 * Every org is out for a while: if Codex may take over here, hand this session
 * to the launcher to run Codex until `d.at`, then resume under `d.org`; true
 * when that started. Otherwise say why and return false (the caller waits).
 */
async function handToCodex($: Engine, d: { org: string; model?: string; at: number }, now: number): Promise<boolean> {
  const r = await $.process.run(['sh', '-c', CODEX_READY_SH])
  if (r.exitCode !== 0) {
    $.ui.toast(`org-switch: every org is limited for a while, but Codex was not started: ${CODEX_NOT_READY[r.exitCode] ?? `the check failed (exit ${r.exitCode})`}. Waiting instead.`, { timeoutMs: 15000 })
    return false
  }
  const was = await $.session.model()
  if (d.model === DOWNGRADE_MODEL && isFable(was)) await $.store.set('downgrade', { from: was } satisfies Downgrade)
  await $.store.set(`resume:${await $.session.id()}`, { go: true, model: d.model ?? was } satisfies Resume)
  startSwitch($, d.org, false, `every org limited; Codex works until ${d.org} frees ${fmtIn(d.at - now)}`, `codex=1\nuntil=${Math.ceil(d.at / 1000)}\n`)
  return true
}

/**
 * Decide from the readings as they are now and carry it out. The first
 * reaction to a limit and every timer set for it come through here with the
 * trigger that started it, so a target is never older than this call and a
 * window warning never turns into a "继续". `probe`: a wait's early look, which
 * tries one "继续" when the wait is still on.
 */
async function react($: Engine, why: Why, detail: string, probe = false): Promise<void> {
  if (!active() || handoffStarted) return
  const cur = env.org as string
  const now = await $.clock.now()
  const last = await $.store.get('lastSwitchAt')
  const d = decide({ now, current: cur, orgs: env.orgs, fable: isFable(await $.session.model()), why, states: await readStates($), lastSwitchAt: typeof last === 'number' ? last : undefined })
  if (d.kind === 'stay') return $.ui.toast(`org-switch: ${cur}: ${detail}; no other org is free. Staying put.`, { timeoutMs: 8000 })
  if (d.kind === 'wait' && d.at > now) {
    // The probe fails cheaply if still limited, and that failure decides again.
    if (probe) return void (await sendContinue($))
    if (d.at - now > TAKEOVER_AFTER_MS && (await handToCodex($, d, now))) return
    return waitFor($, d, now, why, detail)
  }
  const go = d.kind === 'move' ? d.go : why !== 'window'
  await moveTo($, d.org, d.model, go, d.model !== undefined && d.org === cur ? 'Fable limited on every org' : `${cur}: ${detail}`)
}

/**
 * Back on the model a limit moved the session off, once its hold here has
 * passed: from a timer set for then, else when a turn ends, so the next turn
 * starts on it. (A prompt.submit hook may not change the model.)
 */
async function restoreFable($: Engine): Promise<void> {
  const g = (await $.store.get('downgrade')) as Downgrade | null | undefined
  if (g == null) return
  if ((await $.session.model()) !== DOWNGRADE_MODEL) return void (await $.store.delete('downgrade')) // changed by hand
  const now = await $.clock.now()
  const at = availableAt(await readState($, env.org as string), true, now)
  const id = ++restoreId
  if (at > now) {
    $.clock.after(at - now, () => { if (id === restoreId) void restoreFable($) })
    return
  }
  try {
    await $.command.run({ command: 'model', args: g.from })
  } catch {
    return // a turn is running: its turn.complete tries again
  }
  await $.store.delete('downgrade')
  $.ui.toast(`org-switch: Fable is free again; back on ${g.from}.`, { timeoutMs: 8000 })
}

async function onLimited($: Engine, why: Why, detail: string): Promise<void> {
  // A failed turn while only a window warning waits (the switch cooldown) takes that wait over: the turn must go on.
  if (!active() || handoffStarted || (waiting && !(waitWhy === 'window' && why !== 'window'))) return
  const cur = env.org as string
  const now = await $.clock.now()
  const fable = isFable(await $.session.model())
  const block = unexplainedBlock(why, await readState($, cur), fable, now)
  if (block !== undefined) await $.store.set(`block:${cur}`, block)
  await react($, why, detail)
}

async function report($: Engine): Promise<string> {
  const now = await $.clock.now()
  const cur = env.org as string
  const fmtWindow = (kind: string, w: WindowSeen) => {
    const t = w.resetsAt !== undefined ? Date.parse(w.resetsAt) : NaN
    return `${short(kind)} ${w.percentUsed}%${Number.isFinite(t) ? ` (resets ${fmtIn(t - now)})` : ''}`
  }
  const lines = [`on: ${cur}   orgs: ${env.orgs.join(', ')}   switch at ${THRESHOLD}%   context: ${Math.round(contextPct)}% (compacts on switch from ${COMPACT_AT}%)`]
  const limits = lastLimits.length > 0 ? lastLimits : (await $.session.usage()).rateLimits
  lines.push(limits.length > 0 ? `${cur} now: ${limits.map(w => fmtWindow(w.kind, w)).join(', ')}` : `${cur} now: no rate-limit reading yet`)
  for (const org of env.orgs) {
    if (org === cur) continue
    const l = (await readState($, org)).ledger
    if (l === undefined) continue
    const ws = Object.entries(l.windows).map(([k, w]) => fmtWindow(k, w)).join(', ')
    lines.push(`${org} (last seen ${fmtAgo(now - l.seenAt)}): ${ws === '' ? 'no reading' : ws}`)
  }
  return lines.join('\n')
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const started = await next(e)
    await loadEnv($)
    handoffStarted = false
    if (env.org !== undefined) saving = (await $.store.get(`saving:${env.org}`)) != null
    await $.command.register({ name: 'org', description: 'Org rate-limit windows; /org switch [org] moves this session to another org', argumentHint: '[status | switch [org]]' })
    if (!active()) return started
    // A reading can arrive before the launcher's environment is known here, and a full window
    // never moves again: take what the status line has now, so this org's state is on record.
    const usage = await $.session.usage()
    if (usage.rateLimits.length > 0) {
      lastLimits = usage.rateLimits
      await writeLedger($, env.org as string, lastLimits)
      await updateSaving($, env.org as string, lastLimits)
    }
    $.ui.status(statusText(env.org as string, lastLimits))
    // Resumed by a switch: restore the model it chose and continue the turn that
    // failed; after a Codex takeover, say what Codex left instead of "继续".
    const key = `resume:${await $.session.id()}`
    const r = (await $.store.get(key)) as Resume | null | undefined
    const codexExit = env.codexExit
    if (r != null) await $.store.delete(key)
    if (r != null || codexExit !== undefined) {
      $.clock.after(1000, () => {
        void (async () => {
          if (r?.model !== undefined) await $.command.run({ command: 'model', args: r.model })
          await restoreFable($)
          if (codexExit !== undefined) await $.prompt.submit({ text: codexText(codexExit) })
          else if (r?.go) await sendContinue($)
        })()
      })
    }
    return started
  })

  on('session.measure', async ($, e, next) => {
    lastLimits = e.rateLimits
    contextPct = e.context.percent ?? contextPct
    if (active()) {
      const cur = env.org as string
      if (e.rateLimits.length > 0) {
        await writeLedger($, cur, e.rateLimits)
        await updateSaving($, cur, e.rateLimits)
      }
      $.ui.status(statusText(cur, e.rateLimits))
      const hot = e.changed.includes('rateLimits') ? e.rateLimits.find(w => w.percentUsed >= THRESHOLD) : undefined
      if (hot !== undefined) await onLimited($, 'window', `${short(hot.kind)} window at ${hot.percentUsed}%`)
    }
    return next(e)
  })

  on('prompt.submit', ($, e, next) => {
    conversed = true
    return next(e)
  })

  // Saving quota: the main loop's requests think one level less.
  on('turn.step', async function* ($, e, next) {
    if (!saving || e.agentId !== undefined || typeof e.effort !== 'string') return yield* next(e)
    return yield* next({ ...e, effort: lowerEffort(e.effort) })
  })

  // A turn that died on a limit: decide, after the engine has finished with it.
  on('classic.StopFailure', async ($, e, next) => {
    const r = await next(e)
    if (e.error === 'rate_limit' && active()) {
      const hit = lastLimits.find(w => w.percentUsed >= THRESHOLD)
      const fable = isFable(await $.session.model())
      const why: Why = hit === undefined && fable ? 'fable' : 'limit'
      const detail = hit !== undefined ? `${short(hit.kind)} window at ${hit.percentUsed}%` : fable ? 'Fable limit' : 'rate limit'
      $.clock.after(0, () => { void onLimited($, why, detail) })
    }
    return r
  })

  // A turn that worked clears what held this org off and cancels any wait.
  on('turn.complete', async ($, e, next) => {
    const r = await next(e)
    if (e.reason === 'answer' && e.agentId === undefined && active()) {
      waitId++
      waiting = false
      const cur = env.org as string
      const b = (await readState($, cur)).block
      if (b !== undefined && (b.kind === 'all' || isFable(await $.session.model()))) await $.store.delete(`block:${cur}`)
      await restoreFable($)
    }
    // A plugin that runs above this one can pass classic.StopFailure on without it ever reaching the
    // hook above. A turn the API ended while a window is at the limit is that same failure, seen here.
    if (e.reason === 'error' && e.agentId === undefined && active()) {
      const hit = lastLimits.find(w => w.percentUsed >= THRESHOLD)
      if (hit !== undefined) {
        $.clock.after(0, () => { void onLimited($, 'limit', `${short(hit.kind)} window at ${hit.percentUsed}%`) })
      }
    }
    return r
  })

  on('command.run', { command: 'org' }, async ($, e) => {
    if (!active()) return { text: 'org-switch: this session was not started by claude-org; nothing to switch.' }
    const cur = env.org as string
    const usage = `usage: /org [status] | /org switch [org]   (orgs: ${env.orgs.join(', ')})`
    const words = e.args.trim().split(/\s+/).filter(Boolean)
    if (words.length === 0 || (words[0] === 'status' && words.length === 1)) return { text: await report($) }
    if (words[0] !== 'switch' || words.length > 2) return { text: usage }
    let target = words[1]
    if (target !== undefined && (!env.orgs.includes(target) || target === cur)) return { text: usage }
    if (target === undefined) {
      const now = await $.clock.now()
      const fable = isFable(await $.session.model())
      const states = await readStates($)
      target = env.orgs.find(o => o !== cur && availableAt(states[o] ?? {}, fable, now) <= now)
      if (target === undefined) return { text: 'org-switch: every other org is limited; name one to go anyway: /org switch <org>' }
    }
    return { text: startSwitch($, target, shouldCompact(), 'manual /org switch') }
  })
}
