/**
 * Minimal YAML front matter parser for rule files.
 *
 * Supports the subset rule files use: `key: value` scalars (quoted or bare),
 * booleans, inline lists (`[a, b]`), and block lists (`- a`). Anything else
 * is kept as a raw string.
 */

/** Parsed front matter values. */
export type FrontValue = string | boolean | string[]

/** A rule file split into front matter and body. */
export interface ParsedRuleFile {
  data: Record<string, FrontValue>
  body: string
}

const unquote = (v: string): string => {
  const t = v.trim()
  if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) return t.slice(1, -1)
  return t
}

const scalar = (raw: string): FrontValue => {
  const v = raw.trim()
  if (v === 'true') return true
  if (v === 'false') return false
  if (v.startsWith('[') && v.endsWith(']')) {
    return v.slice(1, -1).split(',').map(unquote).filter(s => s.length > 0)
  }
  return unquote(v)
}

/**
 * Split front matter from a rule file.
 * @param text - full file text.
 * @returns front matter fields and the remaining body.
 */
export function parseFrontmatter(text: string): ParsedRuleFile {
  const source = text.replace(/^﻿/, '')
  const m = /^---[ \t]*\r?\n([\s\S]*?)\r?\n?---[ \t]*(?:\r?\n|$)/.exec(source)
  if (m === null) return { data: {}, body: source }
  const data: Record<string, FrontValue> = {}
  let listKey: string | undefined
  for (const line of m[1]!.split(/\r?\n/)) {
    if (/^\s*#/.test(line) || line.trim() === '') continue
    const item = /^\s*-\s+(.*)$/.exec(line)
    if (item !== null && listKey !== undefined) {
      const current = data[listKey]
      const list = Array.isArray(current) ? current : []
      list.push(unquote(item[1]!))
      data[listKey] = list
      continue
    }
    const kv = /^([A-Za-z_][\w-]*)\s*:\s*(.*)$/.exec(line)
    if (kv === null) continue
    const key = kv[1]!
    const value = kv[2]!
    if (value.trim() === '') {
      listKey = key
      data[key] = []
    } else {
      listKey = undefined
      data[key] = scalar(value)
    }
  }
  return { data, body: source.slice(m[0].length) }
}

/**
 * Normalise a globs field: a list, or a comma-separated string.
 * @param value - raw front matter value.
 * @returns glob list (empty when absent).
 */
export function globList(value: FrontValue | undefined): string[] {
  if (value === undefined || typeof value === 'boolean') return []
  const items = Array.isArray(value) ? value : value.split(',')
  return items.map(s => s.trim()).filter(s => s.length > 0)
}
