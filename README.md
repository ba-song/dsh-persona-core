# dsh-persona-core

汐的**独立人格 + 身份 + 情绪 + 注入**插件。当前版本 `0.2.0`，文档核对日期 **2026-11-07**。

## 1. 定位

解决四件事：

1. **身份**：给汐一个稳定 `self_id`、显示名、名字版本与人格版本；改名不改 `self_id`、不改人格版本、不改记忆/情绪数据。
2. **人格**：读 `persona.md`，按 full / brief 渲染成 `dy-persona` 注入块；人格文件内容 hash 决定 `persona_version`。
3. **情绪**：规则打分 + 事件 appraisal + episode + 精力/社交电量；给注入提供短情绪行，给服务/HUD 提供可读状态。
4. **注入**：按会话身份/目录决定是否注入、注入哪一档、给谁注入；子智能体/群聊/白名单外默认不注入。

**不负责**：QQ 消息收发（channel-bridge）、记忆检索（memory-core）、生活/自主行动（autonomy）、HUD 绘制。它只提供 `dyPersona` 服务、9 个 `dy_*` 工具与三个 systemPrompt context。

---

## 2. 工具清单

所有工具返回：

```json
{ "ok": true, "detail": "{\"ok\":true,...}" }
```

`detail` 是 **JSON 字符串**；失败时外层 `ok=false`，`detail` 里是 `{ok:false,error,message}`。  
除特别标注外，工具都只要求 `state.self` 可用；DB 不可用时返回 `E_PERSONA_UNAVAILABLE`，不会抛到宿主。

| 工具 | 参数 | 返回（detail 内） | 门禁/限制 |
|---|---|---|---|
| `dy_persona_whoami` | 无 | `self_id, display_name, persona_version, name_version, inject_mode, allowlisted` | 无 owner 门禁 |
| `dy_persona_rename` | `name` 必填，`reason` 可选 | `self_id, display_name, name_version, unchanged` | 子智能体/fork 拒绝；名字非空、≤40 字符；同名返回 `unchanged:true` |
| `dy_persona_get` | `section` 可选 | `text`；给 section 时 `section/missing`；空人格 `empty:true` | 无 owner 门禁；只读，不改文件 |
| `dy_persona_history` | 无 | `history[]`（old/new/reason/source/changed_at） | 无 owner 门禁 |
| `dy_emotion_state` | 无 | `valence,arousal,certainty,label,intensity,energy,social,updatedAt` | DB 失败返回中性 + `degraded:true` |
| `dy_emotion_timeline` | `hours` 可选（默认 24） | `rows[]`：`at,valence,arousal,label,intensity,trigger,msg_ref` | 只查自己；**rows 含 trigger**（默认已按 `triggerMaxChars` 截断） |
| `dy_emotion_points` | `hours` 可选（默认 24） | `rows[]`：`at,dimension,delta,value_after,trigger,msg_ref` | 同上 |
| `dy_emotion_why` | `hours` 可选（默认 6），`include_trigger` 可选（默认 true） | `points[]`：`at,dimension,delta,valueAfter,msgRef`；有 trigger 时带 `trigger`；`note` | **严格 owner 门禁**：无 header / 子智能体 / fork / 群聊 / 白名单外 → `E_PERMISSION`；hours 需 `(0,720]` |
| `dy_persona_mode` | 无 | `mode,resolved,block_len,allowlisted,emotion_ingest,emotion_threshold,emotion_stats` | 只读；`resolved` 可能是 `owner-callable/unknown/E_PERMISSION` |

### 示例

```json
// dy_persona_whoami {}
{"ok":true,"self_id":"self:1d21547c-…","display_name":"杨汐","persona_version":6,"name_version":1,"inject_mode":"full","allowlisted":2}

// dy_persona_rename {"name":"杨汐","reason":"主人给的姓"}
{"ok":true,"self_id":"self:1d21547c-…","display_name":"杨汐","name_version":1,"unchanged":false}

// dy_persona_get {"section":"说话方式"}
{"ok":true,"text":"- 口语、短句…","section":"说话方式","missing":false}

// dy_emotion_state {}
{"ok":true,"self_id":"self:…","valence":0.09,"arousal":0.30,"certainty":0.63,"label":"平静","intensity":0.30,"energy":0.69,"social":0.72,"updatedAt":1793…}

// dy_emotion_why {"hours":6,"include_trigger":false}
{"ok":true,"points":[{"at":1793…,"dimension":"valence","delta":-0.18,"valueAfter":-0.18,"msgRef":"explicit:…"}],"note":"规则归因，不是心理分析"}
```

`dy_emotion_why` 的触发句可能被省略（`include_trigger=false` 或 `triggerMaxChars=0`）；`msgRef` 为空时返回字符串 `"none"`。

---

## 3. 服务 `dyPersona`

- **provide**：`ctx.provide('dyPersona', service)`
- **inject**：`['tools', 'systemPrompt', 'agents']`
- 消费方必须判空：`const p = ctx.get('dyPersona'); if (!p) { /* 降级 */ }`

| 方法 | 返回/说明 |
|---|---|
| `selfId()` | `self:<uuid>`，稳定不变 |
| `displayName()` | 当前显示名（从 DB 刷新） |
| `personaText()` | 当前 `persona.md` 渲染全文；空串=文件为空/缺失 |
| `voice()` | ≤120 字说话风格 |
| `block()` | `{mode,text}`，调试用注入块 |
| `version()` | `{personaVersion,nameVersion,hash}`；hash 是模板原文，改名不变 |
| `bindingOf(sessionId)` | 身份绑定行（含 `bound:true`）；无记录/缺表 → `null`；只读、无权限门 |
| `roleOf(header)` | `{session_id,persona_id,role,bound}`；缺表/缺行 `bound:false`，不抛 |
| `emotionAt(at,{windowMs=600000})` | `at±window` 内最近一条 `{at,label,intensity,valence,arousal,confidence}`；无数据→`null`；只读、无权限门 |
| `emotionTimeline({from,to,limit=20})` | 同结构数组，时间倒序；`limit` 上限 200；无数据→`[]` |
| `emotion.state()` | `{valence,arousal,certainty,label,intensity,energy,social,updatedAt}`；失败返回中性 + `degraded:true` |
| `emotion.toneHint()` | ≤40 字语气提示 |
| `emotion.why(hours=6,{includeTrigger=true,header})` | 原因链；**严格 owner 门禁** |
| `_emotionLine()` / `_emotionLineFor(header)` | 内部注入用；不属契约，外部别依赖 |

> `emotionAt` / `emotionTimeline` 的 `confidence` 目前为 `null`：`emotion_timeline` 没有该列，不编造；以后加列会自动返回数值。

---

## 4. 配置项（profile `cordis.patch.yml` 的 `config`）

| 键 | 默认 | 作用 |
|---|---|---|
| `dataDir` | `/sdcard/DSHA/人格/数据` | 数据根；可用环境变量 `DSH_PERSONA_DIR` 覆盖 |
| `dbPath` / `personaPath` | `<dataDir>/persona.db` / `<dataDir>/persona.md` | 可单独覆盖 |
| `displayName` | `汐` | 首次建 `self` 行的 seed；之后以库为准 |
| `selfId` | `null` | 可选固定 self id seed |
| `groupDirPrefix` | `群_` | 群聊目录名前缀 |
| `logLevel` | `info` | 保留字段，当前未用于过滤日志 |
| `inject.mode` | `off` | `off/brief/full`；无白名单时仍不注入 |
| `inject.briefBudgetChars` | `250` | brief 默认预算（字） |
| `inject.appendHint` | `true` | 人格块末尾是否附使用提示 |
| `inject.sessionDirs` | `[]` | 白名单；元素可为字符串或 `{dir,mode}` |
| `inject.groupMode` | `off` | 群聊：`off` 拒；`brief` 只给 brief+情绪，同群 60s 最多一次 |
| `inject.channelDirs` | `['/sdcard/DSHA/渠道']` | 渠道目录；情绪行低于阈值也至少给粗粒度 |
| `inject.voiceHint` | `true` | 是否挂 37 字 `dy-voice` 表达约束 |
| `inject.budgetByScope` | `{}` | brief 预算按 `home/channel/group` 覆盖；空=全用 `briefBudgetChars` |
| `bind.enabled` | `true` | 身份轴绑定；关闭后只走旧 `sessionDirs` |
| `bind.cwdPrefixes` | `[]` | 绑定前缀；空=跟随 `sessionDirs` |
| `emotion.ingestEnabled` | `false` | 是否接管情绪事件 |
| `emotion.threshold` | `0.35` | 注入情绪行的强度阈值 |
| `emotion.k` | `0.45` | EMA 平滑系数 |
| `emotion.valenceHalfLifeHours` | `6` | valence 半衰期 |
| `emotion.arousalHalfLifeHours` | `0.5` | arousal 半衰期 |
| `emotion.arousalBaseline` | `0.2` | arousal 基线 |
| `emotion.pointThreshold` | `0.15` | 记转折点的最小 delta |
| `emotion.lowConfidence` | `0.35` | 低置信不写状态 |
| `emotion.triggerMaxChars` | `60` | trigger 截断；**0=不存 trigger** |
| `emotion.auditSampleRate` | `5` | 审计抽样（每 N 次） |
| `emotion.questionWeight` | `0.25` | 疑问句权重 |
| `emotion.selfWeight` | `0.3` | 她自己的 assistant 消息权重 |
| `emotion.ownerFatigueIgnore` | `true` | 主人疲惫词走 concern，不写她的 fatigue |
| `emotion.emptyStreakWarn` | `20` | 注入连续为空告警阈值（只计数） |

示例（**修改 profile 会触发 App 重启，必须统筹者点头**）：

```yaml
- id: persona-core
  name: dsh-persona-core
  config:
    dataDir: /sdcard/DSHA/人格/数据
    inject:
      mode: full
      sessionDirs: [/sdcard/DSHA/生活/数据/home, /sdcard/DSHA/渠道]
    emotion:
      ingestEnabled: true
      threshold: 0.35
```

### 注入 context

| context | order | 内容 |
|---|---|---|
| `dy-persona` | 900 | full 完整人格 / brief 要点 |
| `dy-emotion` | 910 | ≤60 字情绪行；无数字 |
| `dy-voice` | 920 | 37 字表达约束（`先有反应再讲道理；不总结、不列点…`） |

都不设 `required`；注册失败只 warn。子智能体/群聊（默认）/白名单外不注册。

---

## 5. 数据、备份、回滚

### 路径

- 生产：`/sdcard/DSHA/人格/数据/persona.db`（WAL 模式）+ `persona.md`
- 覆盖：`DSH_PERSONA_DIR` 或 `dataDir/dbPath/personaPath`
- 备份目录约定：`/sdcard/DSHA/人格/备份/<批次>-<时间>/`

### 表

| 表 | 用途 |
|---|---|
| `self` | 单行 active：display_name、name_version、persona_version |
| `meta` | schema_version、迁移记录、last_emotion_msg_ref/self_ref/tool_ref |
| `name_history` | 改名历史 |
| `persona_versions` | 每次人格内容 hash 变生成快照 |
| `emotion_state` | valence/arousal/certainty/label/intensity + energy/social/ess_updated_at |
| `emotion_timeline` | 每次情绪变化的点（trigger 可截断/关闭） |
| `emotion_points` | 超过阈值的转折点 |
| `emotion_audit` | 规则命中/低置信审计（采样） |
| `session_bindings` | 会话 ↔ persona 角色绑定（身份轴） |
| `emotion_episodes` | concern/joy/affection/fatigue/worry/frustration 等 episode |
| `emotion_event` | P1a 原始事件（self_report/owner_act/owner_state/tool_result） |
| `emotion_appraisal` | 规则评估（rule_id/emotion/intensity/cause/target） |

`meta.schema_version` 目前写 `2`，但实际数据含 v3 结构（`session_bindings`、episodes/event/appraisal）；迁移是**只增不改**。不要手工改标记。

### 备份（写生产前必做）

```bash
B=/sdcard/DSHA/人格/备份/manual-$(date +%Y%m%d-%H%M%S)
mkdir -p "$B"
cp -p /sdcard/DSHA/人格/数据/persona.db /sdcard/DSHA/人格/数据/persona.db-wal \
      /sdcard/DSHA/人格/数据/persona.db-shm "$B"/ 2>/dev/null || true
sha256sum "$B"/* > "$B/SHA256SUMS.txt"
```

恢复时需先停宿主，再覆盖 db/wal/shm；否则 WAL 可能与主库不一致。

### 迁移脚本

```bash
cd /root/.dsh/plugin-src/dsh-persona-core
# v1→v2：默认 dry-run，--apply 才写，写前自动备份
node scripts/migrate-v1-v2.mjs --db=/tmp/persona.db
node scripts/migrate-v1-v2.mjs --db=/tmp/persona.db --apply

# 情绪迁移：memory.db → persona.db
node scripts/migrate-emotion-v1.mjs --db=/tmp/persona.db --memory-db=/tmp/memory-copy.db
node scripts/migrate-emotion-v1.mjs --db=/tmp/persona.db --memory-db=/tmp/memory-copy.db --apply
node scripts/migrate-emotion-v1.mjs --db=/tmp/persona.db --rollback --apply
```

- 生产 persona 路径（新旧）默认拒绝，需 `--force-prod`；线上 memory.db（新路径+旧机器路径）默认拒绝，需副本。
- 所有脚本默认 dry-run，写前备份；不删源文件。

---

## 6. 典型用法

1. **她查自己是谁**：`dy_persona_whoami` → `self_id/display_name/persona_version`；或 `dy_persona_get` 读「我是谁」。
2. **主人让她改名**：`dy_persona_rename {"name":"杨汐","reason":"…"}`；`self_id`/`persona_version`/记忆/情绪不变，只 `name_version+1`。
3. **情绪自查与溯源**：先 `dy_emotion_state` 看 label/energy/social；再 `dy_emotion_timeline {"hours":24}` 看曲线；主人会话可用 `dy_emotion_why` 看原因链（含 trigger 截断）。
4. **记忆/autonomy 判身份**：`dyPersona.roleOf(header)` 判断会话是否绑定；`bindingOf(sessionId)` 取绑定行；`emotionAt/emotionTimeline` 回填情绪，不读对话正文。
5. **注入排障**：`dy_persona_mode` 看 mode/白名单命中/block_len；`dy_persona_get {"section":"说话方式"}` 看实际文本；改 profile 后必须走重启验收。
6. **HUD 读电量**：`dy_emotion_state` 已返回 `energy/social`（0.1–1），客户端直接展示；数值不进注入。

---

## 7. 边界与已知限制

- **不接管消息流**：不调用 QQ/桥、不发送消息、不读写 memory.db/onebot settings。
- **默认 off**：`inject.mode=off`、`sessionDirs=[]` 时只提供工具/服务，不注入。
- **群聊**：默认 `groupMode=off` 拒；`brief` 时只给 brief+情绪行，不回 full，不 ingest，同群 60s 最多一次（进程内，重启重置）。
- **子智能体**：真子智能体不注入（`origin=subagent`/`delegationDepth>0`）；fork 按普通会话注入（D2 口径）。`why` 对 fork/群/白名单外严格拒绝。
- **情绪不是事实**：注入只给标签/短句，不含数值；规则归因不是心理分析，不参与事实判定。
- **trigger 隐私**：默认 60 字截断，`triggerMaxChars=0` 不存 trigger；但 `dy_emotion_timeline/points` 返回行里仍可能带已截断 trigger（工具无 owner 门禁），非主人会话不要转发。
- **episode 去重有限**：冷落按会话每段一次；工具失败按 seq 去重；owner 夸奖/自述/工具失败目前每条可生成 episode，输出只取最强一条。
- **冷落计数在内存**：重启清零；不持久化。
- **迁移/重启**：加列/建表发生在宿主启动首次 `openDb`，只增不改；生产迁移前必须备份。
- **self 冲突**：多行 active 时不注入、工具报 `E_SELF_CONFLICT`，不猜行。
- **P1a 仍是规则版**：不是完整 OCC/FAtiMA appraisal；LLM 反思未接。

---

## 8. 测试与同步

```bash
cd /root/.dsh/plugin-src/dsh-persona-core

# 全量测试（2026-11-07 基线：233/233 全绿）
env -u DSH_PERSONA_DIR node --test tests/*.test.mjs

# 只跑某一组
node --test tests/p1a-events.test.mjs
node --test tests/p0-concern-energy.test.mjs

# 改完插件后同步到 SD 卡备份（必做）
sh /sdcard/DSHA/插件开发/自建插件/sync-from-ubuntu.sh
cat /sdcard/DSHA/插件开发/自建插件/.last-sync
cat /sdcard/DSHA/插件开发/自建插件/MANIFEST.md
```

- 测试全部使用临时目录/合成人格，不写生产库；`memory-regression` 只读复制 memory.db 做哈希/聚合比对。
- 涉及插件注册/profile 的改动，**请主人重启前**还要跑：
  `node /sdcard/DSHA/工作区/统筹/verify-restart.mjs`（必须“全部通过”）。
- 本插件不自行重启、不改 profile；`cordis.patch.yml`/profile 改动必须统筹者点头。
