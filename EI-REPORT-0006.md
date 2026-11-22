# EI-REPORT-0006 · 人格与情绪主线复核（PERSONA-EI-CURRENT-STATE-READONLY-01）

> 仓库：`ba-song/dsh-persona-core`
> 分支：`ei/pre-ei2a-review-01`（基于 `4992a31`，仅新增本报告）
> 任务：`PERSONA-EI-CURRENT-STATE-READONLY-01`
> 生成时间：2026-11-22 09:30 (Asia/Shanghai)
> 性质：只读审查、隔离测试与报告；不授权 EI-2A、schema 修改、生产迁移、注入切换、部署或重启。

## 版本历史

| 版本 | 位置 | 时间 | 内容 |
|---|---|---|---|
| EI-REPORT-0002 | memory coordination | 2026-11-21 | `b1cac0f` 定向 20/21、全量 323/324 |
| EI-REPORT-0003 | memory coordination | 2026-11-21 | `3a1376` 定向 21/21、全量 324/324，代码隔离 PASS |
| EI-REPORT-0004 | persona `ei/pre-ei2a-review-01` | 2026-11-21 | `1572e49` 复核、EI-2A 前置审查 |
| EI-REPORT-0005 | 同上 | 2026-11-21 | GPT 设计裁决记录（B1/B2/D3/D1–D7） |
| EI-REPORT-0006 | 本文件 | 2026-11-22 | 主线复核：EI-1 复跑、EI-2 设计修订核验、schema fixture、主线缺陷复现 |

---

## 0. 阅读导航

1. 基线与分支关系
2. EI-1 隔离复跑
3. EI-1 代码契约核对
4. EI-2 设计修订核验（B1/B2/D3 与其他）
5. 分支/报告一致性
6. schema fixture 隔离验证
7. 主线已知缺陷复现
8. 结论与最小后续工作包
9. 未授权事项
10. 证据索引
11. 边界声明

---

## 1. 基线与分支关系

| 项 | 实测 |
|---|---|
| 仓库 | `ba-song/dsh-persona-core` |
| main | `a84c7badd1e6c971a66b6c39dd4f7ab795df4b90`（未变） |
| EI-1 修复分支 | `fix/ei1-source-ref-experiencer-contract` @ **`8ccb8a922a789d8d15157b9d99f9de0c20c8807b`** |
| EI 报告分支 | `ei/pre-ei2a-review-01` @ **`4992a313f72326caa4b5e84558005a53db239af0`** |
| 本报告分支 | `ei/pre-ei2a-review-01`（基于 `4992a31`） |
| main..fix | 26 commits |
| main..report | 27 commits |
| fix..report | 2 commits（报告 0005 侧） |
| report..fix | 1 commit（设计修订 8ccb8a9） |
| 分叉点 | `1572e49ce0fd9c713f119ff8300af91db3c2bb1e` |

### 关键 blob

| 文件 | fix 分支 8ccb8a9 | report 分支 4992a31 |
|---|---|---|
| `lib/emotion-compose.js` | `cf033ec8400ea38e717481a46a5bfe834276a4a5` | 同 |
| `tests/emotion-compose.test.mjs` | `eb17cb0f2c67450a145f38d1a582bef6d90b07c8` | 同 |
| `EI-2-PERSISTENCE-DESIGN-01.md` | **`670e5a34a1916a8b104ebfd1004b525236677d4c`** | **`d79bd124167dec45968fc5aece7060017fc75057`** |
| `EI-REPORT-0005.md` | 不存在 | `e23d98c920f1a9979e1e83400123288e3ee8c88f` |

**核心发现**：`8ccb8a9` 的设计修订**不在** `4992a31` 报告分支上；0005 声称的设计 blob `670e5a3` 在 fix 分支，报告分支仍是旧版 `d79bd12`。两个分支在 `1572e49` 分叉，未互相包含。

### 共享状态文件

- HANDOFF：`coordination/project-handoff` @ `2a416c3`，blob `b210d0a09200fd87e5f0fce0b4f08ded38dfe70a`；HANDOFF-0074/0076 已记录 EI 设计/报告分支不同步。
- REPORT：同分支，blob `02c430b8417bddd05645cfa6ef18fb8e8d169503`；REPORT-0015 §2.2 记录设计 blob `670e5a3`，但报告分支实际是 `d79bd12`。
- 未修改 HANDOFF/REPORT/PROJECT.md。

---

## 2. EI-1 隔离复跑

在全新 worktree `/tmp/ei1-8ccb8a9`（`git worktree add --detach 8ccb8a9`）执行：

| 命令 | 结果 | 退出码 | 日志 |
|---|---|---|---|
| `node --version` | v24.19.0 | 0 | — |
| `npm --version` | 11.17.0 | 0 | — |
| `git rev-parse HEAD` | `8ccb8a922a789d8d15157b9d99f9de0c20c8807b` | 0 | — |
| `node --test tests/emotion-compose.test.mjs` | **21 / 21 pass / 0 fail / 0 skip** | **0** | `/tmp/ei1-8ccb8a9-target.log` |
| `npm test` | **324 / 324 pass / 0 fail / 0 skip** | **0** | `/tmp/ei1-8ccb8a9-full.log` |
| `git status --short` | 空 | 0 | — |
| `git diff --check` | 空 | 0 | — |

**结论**：EI-1 代码隔离验收 **PASS（本轮实测）**；只能写“代码隔离验收 PASS，待负责人/DSH 设备复验”。  
DSHA/设备复验 **NOT RUN**；生产集成 **NOT RUN**。

---

## 3. EI-1 代码契约核对

用 `/tmp/ei1-8ccb8a9-probe.mjs` 直接调用模块，结果：

| 检查 | 结果 | 状态 |
|---|---|---|
| `sourceIds` 含 `id/episodeId/episode_id` 与 `appraisalId/appraisal_id` | `[12,13,14,88,89,'event:5','raw:4']` | **PASS** |
| `sourceRefs` 全部 episode/appraisal/event/raw | 7 条 refs 全含 | **PASS** |
| 同数字 ID 不同类型独立 | episode:7 / appraisal:7 / event:7 → 3 条 | **PASS** |
| 去重 / 多 episode 合并 | 重复 refs 去重；合并保留 | **PASS** |
| 缺失 experiencer → unknown | `unknown`，`primaryForSelf=null` | **PASS** |
| 裸 ID / 匹配前缀 / 冲突前缀 / unknown 非空 ID / 旧式 `self:<id>` | `owner:123`、`owner:456`、冲突 total=0、unknown 清空、`self:1d2` 解析 | **PASS** |
| target 与 experiencer 分离 | `target='self'` 与 `experiencer='unknown'` 独立 | **PASS** |
| unknown 不进 self 投影 | unknown-only `primaryForSelf=null`；`selfEmotions=[]` | **PASS** |
| owner/third_party 不进 selfEmotions | 均 `injectable=false`、`primaryForSelf=null` | **PASS** |
| self + owner 混合 | 通用 `primary=owner`，`primaryForSelf=self` | **PASS** |
| 只有 self 且达阈值才 injectable | self+active 才 true | **PASS** |
| 置信度门槛 | 0.64 → total=0；0.65 → active；0.5 legacy → 可见但 `injectable=false` | **PASS（按门槛）** |
| 衰减 | 1 小时半衰：强度 0.8→0.4 | **PASS** |
| 合并/排序/确定性 | 同 label 取最大衰减强度；全量测试通过 | **PASS** |
| 生产接入 | 无非测试代码 import；`index.js` 未引用 | **NOT RUN（生产）/ PASS（隔离）** |

---

## 4. EI-2 设计修订核验

设计基线：fix 分支 `8ccb8a9` 的 `EI-2-PERSISTENCE-DESIGN-01.md`，blob `670e5a3`。

### 4.1 B1 confidence 语义

| 检查 | 结果 | 状态 |
|---|---|---|
| `emotion_appraisal` 有 `confidence_kind` / `confidence_source` | 有：§3.2 `:80-81`；枚举 `unknown/rule_default/calibrated/legacy_unclassified` | **PASS（字段）** |
| `emotion_appraisal_items` 有同字段 | 有：§3.2 `:83` | **PASS** |
| 旧行 `legacy_unclassified` / `legacy_migration` | 有默认值 | **PASS（旧行）** |
| **新写入默认值安全性** | `confidence_kind DEFAULT 'legacy_unclassified'`、`confidence_source DEFAULT 'legacy_migration'`；新插入若漏传字段，会被标成 legacy，而不是 `unknown` | **FAIL / BLOCKER（B1 residual）** |
| `emotion_event.confidence` 是否也有 kind/source | §3.1 `:60-68` 仍只有旧 `confidence`，无 `confidence_kind/source`；是否用于门控未声明 | **PARTIAL（需声明）** |

**B1 结论**：字段已加，但**默认值会把新数据误标为 legacy**，与“缺失必须 unknown”冲突；EI-2A 冻结前必须改为 `unknown`/`unknown` 或取消默认、强制显式写入，并在迁移中显式把旧行标 legacy。

### 4.2 B2 legacy dedupe_key

- 设计 §3.1 `:63`：旧行 `legacy:event:<event_id>`；缺失 `source_kind` 补 `legacy`；已有非空 key 保留；trim + NFC；空值拒绝。
- 合成 fixture `/tmp/ei-schema-fixtures/contract-probe.mjs`：id 1/2 生成 `legacy:event:1/2`，id 3 保留 `keep:3`；两次应用结果一致，唯一性通过。
- **B2 结论：PASS（公式可测）/ 迁移 NOT RUN**。

### 4.3 D3 生命周期

- 设计 §3.3 `:101`：`effective_end_at = min(非空 ended_at, expires_at)`；两者 NULL 无硬截止；ended_at 不延长 expires_at；half-life 只影响强度。
- 合成 probe：`bothNull=null`、expiryEarlier=100、endedEarlier=100、onlyEnded=150。
- **D3 结论：PASS（规则明确）/ 实现 NOT RUN**。
- 小问题：现有 `emotion_episodes.expires_at` 是 `NOT NULL`，设计又说“两者都 NULL 时无硬截止”；该分支对旧表不可达，需说明新表是否允许 NULL，或删掉该句。

### 4.4 其他设计项

| 项 | 结果 | 状态 |
|---|---|---|
| appraisal + appraisal_items 多情绪模型 | §3.2 一条 appraisal + items；`(appraisal_id,item_index)` 唯一；旧列镜像待 EI-2A | **PASS（模型）/ PARTIAL（镜像）** |
| appraisal_version 唯一约束 | §3.2 明确 `CREATE UNIQUE INDEX uq_emotion_appraisal_event_version` | **PASS** |
| episode_revision 与 idem_key | §3.3 `:99`、§5 `:148` | **PASS** |
| target_type=tool | §2.2 `:43` | **PASS** |
| sourceRefs raw→raw_message | §3.4 `:112` 明确 EI-1 仍输出 raw，EI-2A 持久化边界归一化 | **PASS（设计）/ 实现 NOT RUN** |
| outbox/inbox 阶段 | §8 `:239` 明确 EI-2A 不建/不运行，留 EI-2D | **PASS** |
| event/appraisal/episode 原子性 | §11.1 `:267` 识别无事务；未修 | **PASS（识别）/ FAIL（代码现状）** |
| timeline `session_key/self_id` | §11.3 `:269` 识别；未修 | **PASS（识别）/ FAIL（代码现状）** |
| schema_version/真实结构探测 | §11.6 `:272` 要求 PRAGMA/sqlite_master + 三类 fixture | **PASS（设计）/ NOT RUN（实现）** |
| 旧 API 兼容 / shadow-only | §6.5/6.6；新读取 API 未写 | **PASS（2A）/ 后续 2C** |

### 4.5 文档一致性

- §9「未决项」仍包含 §12.4 已裁决的 D2 third_party、D4 旧 348 条、D5 阈值等；§12.2「尚未冻结」仍列已定稿的 source type 映射（§12.2.3 与 §3.4 内容重复/冲突）。
- 这不是 schema blocker，但会让实现者误判哪些还需决策；建议把已裁决项移出「未决」，保留 D1 owner 确认等真正未决项。

---

## 5. 分支/报告一致性

| 事实 | 证据 | 状态 |
|---|---|---|
| 0005 声称设计 blob `670e5a3` | `EI-REPORT-0005.md` §1/§2.2 | **FAIL（分支不一致）** |
| 0005 所在分支实际设计 blob `d79bd12` | `git rev-parse 4992a31:EI-2-PERSISTENCE-DESIGN-01.md` | **FAIL** |
| 设计修订 8ccb8a9 在 fix 分支 | `git rev-parse 8ccb8a9:...` = `670e5a3` | **PASS（fix 分支）** |
| 两分支分叉于 1572e49 | `git merge-base fix report` = `1572e49` | **PASS（事实）** |

**结论**：报告分支不是自包含的；0005 引用的设计版本不在其分支上。  
**建议**：GPT/负责人决定同步方式（在报告分支 cherry-pick/merge 8ccb8a9 的设计文档，不改 EI-1 代码），然后重发 0005 或新增勘误；不得 force push，不得覆盖他人提交。

---

## 6. schema fixture 隔离验证

仅用 `/tmp/ei-schema-fixtures` 合成 SQLite，不读取生产 DB：

| fixture | meta.schema_version | 结构 | 分类 |
|---|---|---|---|
| `old.db` | 1 | 无 event/appraisal/episodes | `old` |
| `partial.db` | 2 | 有 event/appraisal/episodes，但 episodes 无 `appraisal_id`、appraisal 无 attunement 列 | `partial` |
| `full.db` | 2 | 由 `openDb()` 建出的完整 v2 结构（含 `appraisal_id`、`intent/user_cue/uncertainty/avoid_json`） | `full` |

检测使用 `sqlite_master` + `PRAGMA table_info`，结果：

```json
{"fixture":"old","meta_schema_version":"1","classified":"old"}
{"fixture":"partial","meta_schema_version":"2","classified":"partial"}
{"fixture":"full","meta_schema_version":"2","classified":"full"}
```

**结论**：`meta.schema_version` 单独不足以区分 partial/full；结构探测可安全区分三类 fixture。  
**状态**：PASS（分类策略可测）；真实 migration **NOT RUN**，未执行任何 schema 修改。

---

## 7. 主线已知缺陷复现

### 7.1 timeline `session_key` / `self_id`

- 代码：`lib/emotion.js:645` 写 `emotion_timeline(session_key,...)`；实际表列 `self_id`（`lib/db.js:124-134`）；异常被 `:647` 空 catch 吞掉。
- 复现：临时 DB 调用 `applyCoreAppraisal`；`emotion_state` 更新成功，`emotion_timeline` 前后均为 **0**；返回 state 正常。日志 `/tmp/ei-timeline-repro/repro.log`。
- **状态：FAIL（代码现状，P1）**；修复 NOT RUN。

### 7.2 event/appraisal/episode 非原子

- 代码：`recordRuleEpisode` 三连 INSERT 无统一事务（`lib/emotion.js:652-730`）。
- 复现：临时 DB 删除 `emotion_episodes` 表后调用；抛 `no such table: emotion_episodes`，但 `emotion_event=1`、`emotion_appraisal=1` 残留。日志 `/tmp/ei-atomic-repro/repro.log`。
- **状态：FAIL（代码现状，P1）**；修复 NOT RUN。

### 7.3 生产/设备

- 未读取生产情绪正文；未写生产 persona.db；未部署/重启/staging。
- DSHA 设备复验：**NOT RUN**。

---

## 8. 结论与最小后续工作包

### 8.1 结论

| 问题 | 结论 |
|---|---|
| EI-1 代码隔离验收 | **PASS（本轮 8ccb8a9 实测 21/21、324/324）** |
| EI-1 设备/生产 | **NOT RUN**；只能写“代码隔离 PASS，待负责人/DSH 设备复验” |
| B1 confidence 修订 | **FAIL/PARTIAL**：字段已加，但新写入默认值会把新数据标成 legacy；event confidence 未定 kind |
| B2 dedupe_key 修订 | **PASS（公式可测）；迁移 NOT RUN** |
| D3 生命周期修订 | **PASS（规则明确）；实现 NOT RUN** |
| 报告/设计分支一致性 | **FAIL/BLOCKER**：0005 引用 670e5a3，当前报告分支是 d79bd12 |
| schema 三类 fixture | **PASS（分类可测）；migration NOT RUN** |
| 主线 timeline/原子性缺陷 | **FAIL（已复现）；修复 NOT RUN** |
| EI-2A | **NOT RUN**，未获授权 |

### 8.2 最小后续工作包（建议）

1. **WP1（P0，报告/设计同步）**：将 `8ccb8a9` 的设计文档同步到报告分支（cherry-pick/merge，不改 EI-1 代码），重发或勘误 0005；不得 force push。
2. **WP2（P0，B1 residual）**：把 `confidence_kind`/`confidence_source` 默认改为 `unknown`/`unknown`（或取消默认强制显式），迁移时把旧行显式标 `legacy_unclassified/legacy_migration`；决定 `emotion_event.confidence` 是否也加 kind 或声明不参与门控。
3. **WP3（P0，文档一致性）**：清理 §9「未决项」/§12.2 中已裁决项（D2/D4/D5、source mapping），只保留真正未决的 D1、raw_message 引用、outbox 重试等。
4. **WP4（P1，隔离验证）**：用三类 fixture 做 EI-2A migration 剧本（只在临时 DB）；验证 B2 公式、B1 旧行标记、D3 边界、旧 API 不变；不写生产。
5. **WP5（P1，主线缺陷）**：单独修 timeline `session_key→self_id` 和三连 INSERT 事务；需另行授权，不能混入 EI-2A schema 变更。
6. **WP6（P1，设备）**：准备 EI-1 DSHA 只读复验材料；部署/重启/注入切换另需授权。

### 8.3 EI-2A 最小范围（若负责人授权）

- persona 本地 schema 增量 DDL + migration 脚本；
- 旧/部分扩展/完整三类 fixture；
- 幂等、故障回滚、旧 API 不变；
- 只写不读；不建/不运行 outbox/inbox；
- 临时副本验证，不写生产。

明确不属于 EI-2A：EI-2B 写入接入、EI-2C 读取 API/投影、EI-2D outbox/inbox、EI-2E DSHA shadow、EI-2F 生产、Memory 关联/recall 权重。

---

## 9. 未授权事项

- 生产 persona.db/memory.db 写入或迁移；
- schema 修改（EI-2A 未授权）；
- 注入切换、部署、重启、staging；
- 合并 main、接生产注入；
- 修改 Memory 仓库；
- 把 EI-1 代码隔离 PASS 写成 DSHA/生产 PASS。

---

## 10. 证据索引

| 结论 | 证据 |
|---|---|
| 分支 HEAD | main `a84c7ba`；fix `8ccb8a9`；report `4992a31` |
| 代码/测试 blob | `cf033ec…` / `eb17cb0…`（fix/report 相同） |
| 设计 blob | fix `670e5a3`；report `d79bd12` |
| 0005 报告 blob | `e23d98c…` |
| 定向测试 | `/tmp/ei1-8ccb8a9-target.log`：21/21，exit 0 |
| 全量测试 | `/tmp/ei1-8ccb8a9-full.log`：324/324，exit 0 |
| 工作区 | `git status --short` 空；`git diff --check` 空 |
| B1 字段 | 设计 §3.2 `:80-83`；默认值同段 |
| B2 公式 | 设计 §3.1 `:63`；`/tmp/ei-schema-fixtures/contract-probe.mjs` |
| D3 | 设计 §3.3 `:101`；probe `effective_end` |
| 分支分叉 | `git merge-base` = `1572e49` |
| schema fixture | `/tmp/ei-schema-fixtures/detect.mjs` 输出 old/partial/full |
| timeline 复现 | `/tmp/ei-timeline-repro/repro.log`：timeline 0 |
| 原子性复现 | `/tmp/ei-atomic-repro/repro.log`：event=1、appraisal=1 |
| HANDOFF 已知不一致 | HANDOFF-0074/0076 已记录 670e5a3 vs d79bd12 |

---

## 11. 边界声明

- 只读审查与隔离测试：临时 worktree、临时 SQLite、合成 fixture；未读取生产情绪正文，未写生产 DB。
- 未修改 EI-1 源码/测试/EI-2 设计文档；未修改 Memory 仓库或共享 HANDOFF/REPORT。
- 未执行 schema migration、部署、重启、staging；未合并 main；未接生产注入；未启动 EI-2A。
- 仅新增本报告文件于 `ei/pre-ei2a-review-01` 分支。
