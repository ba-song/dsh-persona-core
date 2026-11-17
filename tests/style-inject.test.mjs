import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readStyleLine } from '../lib/inject.js'

const DIR = mkdtempSync(join(tmpdir(), 'persona-style-'))
test('读语感文件：正常返回一行；不存在/过期返回空', () => {
  const p = join(DIR, 'style.json')
  writeFileSync(p, JSON.stringify({ summaryLine: '主人发消息中位 28 字；95% 不带句号' }))
  assert.ok(readStyleLine(p).includes('【语感】'))
  assert.ok(readStyleLine(p).includes('95%'))
  assert.equal(readStyleLine(join(DIR, 'none.json')), '')
  writeFileSync(p, JSON.stringify({ summaryLine: '' }))
  assert.equal(readStyleLine(p), '')
})
test.after(() => { try { rmSync(DIR, { recursive: true, force: true }) } catch {} })
