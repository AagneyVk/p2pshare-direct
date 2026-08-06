import React from 'react'

// ── Button ────────────────────────────────────────────────────────
interface BtnProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  ghost?: boolean
  sm?: boolean
}
export function Btn({ ghost, sm, className = '', children, ...rest }: BtnProps) {
  return (
    <button
      className={`btn${ghost ? ' ghost' : ''}${sm ? ' sm' : ''} ${className}`}
      {...rest}
    >
      {children}
    </button>
  )
}

// ── Text Input ────────────────────────────────────────────────────
interface InputProps extends React.InputHTMLAttributes<HTMLInputElement> {
  large?: boolean
}
export function PixInput({ large, className = '', ...rest }: InputProps) {
  return (
    <input
      className={`input${large ? ' large' : ''} ${className}`}
      {...rest}
    />
  )
}

// ── Progress Bar ──────────────────────────────────────────────────
interface ProgressProps {
  value: number   // 0–1
  label?: string
}
export function ProgressBar({ value, label }: ProgressProps) {
  const pct = Math.round(Math.min(1, Math.max(0, value)) * 100)
  return (
    <div className="progress-bar">
      <div className="progress-bar__fill" style={{ width: `${pct}%` }} />
      <span className="progress-bar__label">{pct}%</span>
    </div>
  )
}

// ── Badge ─────────────────────────────────────────────────────────
export function Badge({ text, dim }: { text: string; dim?: boolean }) {
  return (
    <span className={`badge ${dim ? 'waiting' : 'connected'}`}>
      {text}
    </span>
  )
}

// ── Spinner ───────────────────────────────────────────────────────
export function Spinner() {
  return <span className="spinner" />
}

// ── Divider ───────────────────────────────────────────────────────
export function Divider() {
  return <hr className="divider" />
}

// ── Session Code Display ──────────────────────────────────────────
export function CodeDisplay({ code }: { code: string }) {
  return (
    <div className="session-code">
      {code || '······'}
    </div>
  )
}

// ── File Input trigger ────────────────────────────────────────────
interface FilePickProps {
  onFile: (f: File) => void
  disabled?: boolean
}
export function FilePick({ onFile, disabled }: FilePickProps) {
  const ref = React.useRef<HTMLInputElement>(null)
  return (
    <>
      <input
        ref={ref}
        type="file"
        style={{ display: 'none' }}
        onChange={e => { const f = e.target.files?.[0]; if (f) { onFile(f); e.target.value = '' } }}
        disabled={disabled}
      />
      <Btn ghost onClick={() => ref.current?.click()} disabled={disabled}>
        SEND FILE
      </Btn>
    </>
  )
}
