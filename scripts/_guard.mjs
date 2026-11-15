/** 脚本公共守卫：拒绝在没显式确认时碰生产库；所有脚本默认 dry-run。 */
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'

/** 生产 persona.db：2026-11-04 迁移后的新路径 + 旧机器遗留路径（都拦）。 */
export const PROD_DBS = [
  '/sdcard/DSHA/人格/数据/persona.db',
  '/sdcard/Documents/DSH记忆档案/persona/persona.db',
]
export const PROD_DB = PROD_DBS[0]

export function parseArgs(argv = process.argv.slice(2)) {
  const out = { _: [] }
  for (const arg of argv) {
    if (arg.startsWith('--')) {
      const [k, v] = arg.slice(2).split('=')
      out[k] = v === undefined ? true : v
    } else out._.push(arg)
  }
  return out
}

export function resolveDbPath(args) {
  const p = args.db ?? args._[0]
  if (!p) {
    console.error('缺少 --db=<path>（本脚本不猜默认生产路径）')
    process.exit(2)
  }
  const abs = resolve(String(p))
  if (!existsSync(abs) && args.allowMissing !== true) {
    console.error(`库不存在：${abs}`)
    process.exit(2)
  }
  return abs
}

export function guardProduction(path, args) {
  // 兼容 `--force-prod` 与 `--forceProd` 两种写法
  const forced = args.forceProd === true || args['force-prod'] === true
  const isProd = PROD_DBS.some((p) => resolve(path) === resolve(p))
  if (isProd && !forced) {
    console.error(`拒绝操作生产库：${path}\n确认要动生产请加 --force-prod（阶段 2 不允许）`)
    process.exit(3)
  }
}

export function stamp() {
  const d = new Date()
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
}
