# EI-REPORT-0004 · EI-1 阶段性收口与 EI-2A 实施前审查

> 仓库：`ba-song/dsh-persona-core`
> 分支：`ei/pre-ei2a-review-01`（独立报告分支，基于 `1572e49`）
> 任务：`EI-PRE-EI2A-REVIEW-01`
> 生成时间：2026-11-21 12:05 (Asia/Shanghai)
> 性质：只读审查与文档整理；不是 EI-2A 实施，不代表 schema v3、迁移、生产注入或部署获批。

## 版本历史

| 版本 | 位置 | 时间 | 内容 |
|---|---|---|---|
| EI-REPORT-0002 | `dsh-memory-core` coordination | 2026-11-21 10:45 | `b1cac0f` 验收：定向 20/21、全量 323/324，`sourceIds` 缺 `episode_id` |
| EI-REPORT-0003 | `dsh-memory-core` coordination | 2026-11-21 11:00 | `3a1376` 验收：定向 21/21、全量 324/324，代码隔离 PASS |
| EI-REPORT-0004 | `dsh-persona-core` 独立分支 | 2026-11-21 12:05 | 本轮：`1572e49` 复核、EI-2A 实施前审查、blocker/decision 清单 |

> 本轮任务明确禁止修改 Memory 仓库，因此 0004 不写入 `dsh-memory-core/coordination`；如需回到统一 coordination，由 GPT 整合。未覆盖或删除 0002/0003。

---

## 0. 阅读导航

1. 基线
2. EI-1 复核
3. EI-2 设计逐项审查
4. 问题分类：BLOCKER / DESIGN DECISION / IMPLEMENTATION REQUIREMENT / LATER
5. EI-2A 最小范围与明确排除
6. 结论与回答
7. 未授权事项
8. 仍需设备/负责人验证
9. 证据索引
10. 边界声明

---

## 1. 基线

| 项 | 值 |
|---|---|
| 仓库 | `ba-song/dsh-persona-core` |
| 当前分支 | `fix/ei1-source-ref-experiencer-contract` |
| **实际 HEAD** | **`1572e49ce0fd9c713f119ff8300af91db3c2bb1e`** |
| HEAD 时间/标题 | 2026-11-21 11:07:10 +0800 `docs(ei): distinguish tested code commit from documentation head` |
| EI-1 代码验收目标 | `3a1376184491d94b02d4c3ad4990a957e85acb48` |
| 基线 main | `a84c7badd1e6c971a66b6c39dd4f7ab795df4b90`（未变） |
| 3a1376 之后提交 | `7750e91`、`80eaedd`、`1572e49`，仅改 EI-2 文档 |
| 隔离 worktree | `/tmp/ei1-1572e49`，detached；本轮报告分支 `ei/pre-ei2a-review-01` |
| Node / npm | v24.19.0 / 11.17.0（满足 Persona `>=22`） |

### 文件 blob（本轮实测）

| 文件 | 1572e49 blob | 与 3a1376 对比 |
|---|---|---|
| `lib/emotion-compose.js` | `cf033ec8400ea38e717481a46a5bfe834276a4a5` | **相同** |
| `tests/emotion-compose.test.mjs` | `eb17cb0f2c67450a145f38d1a582bef6d90b07c8` | **相同** |
| `EI-2-PERSISTENCE-DESIGN-01.md` | `d79bd124167dec45968fc5aece7060017fc75057` | 已更新（4 处文档修正） |

**关键事实**：当前 HEAD 只在 3a1376 之后改了文档；EI-1 代码与测试 blob 未变。因此本轮 1572e49 复跑结果与 3a1376 报告应一致，仍以本轮实测为准。

### 此前 EI 报告 404 核查

- `dda87711e2090f644441e6be0991cfed88f4d9e9` 在远端存在；`git cat-file -t` = commit。
- 它是当前 `coordination/project-handoff` tip `eade5a2` 的祖先：`git merge-base --is-ancestor dda8771 eade5a2` = YES。
- 当前 coordination tip 上 `coordination/EI 情绪智能负责人报告.md` blob 仍是 `2a5ffb29e29c5c526aea8d1ba85fb69088ec48cd`，与 dda8771 中相同；`git diff dda8771..tip -- 报告` 为空。
- GitHub API `repos/ba-song/dsh-memory-core/commits/dda8771...` 本轮返回 200；未能复现 404。
- 结论：报告**未被后续提交替代**；dda8771 仍在历史中，文件内容未变。GPT 此前的 404 可能是旧 URL/缓存/权限瞬时问题，未发现仓库侧删除或强推。

---

## 2. EI-1 复核

### 2.1 测试（本轮在 1572e49 实际执行）

| 命令 | 结果 | 退出码 | 日志 |
|---|---|---|---|
| `node --version` | v24.19.0 | 0 | — |
| `npm --version` | 11.17.0 | 0 | — |
| `node --test tests/emotion-compose.test.mjs` | **21 / 21 pass / 0 fail / 0 skip** | **0** | `/tmp/ei1-1572e49-target.log` |
| `npm test` | **324 / 324 pass / 0 fail / 0 skip** | **0** | `/tmp/ei1-1572e49-full.log` |
| `git status --short` | 空 | 0 | — |
| `git diff --check` | 空 | 0 | — |

### 2.2 代码核对

| 检查 | 结果 | 状态 |
|---|---|---|
| `sourceIds` 含 `id/episodeId/episode_id` 与 `appraisalId/appraisal_id` | `lib/emotion-compose.js:122`；测试 `:149` | **PASS** |
| `sourceRefs` 含 type/id/role，全部 episode/appraisal/event/raw | `:93-94`；7 条 refs 全含 | **PASS** |
| 同数字 ID 不同类型独立 | episode:7 / appraisal:7 / event:7 → 3 条 | **PASS** |
| 去重 / 多 episode 合并 | 重复 refs 去重；合并保留 | **PASS** |
| 缺失 experiencer → unknown | `:39-41`；`primaryForSelf=null` | **PASS** |
| 裸 ID / 匹配前缀 / 冲突前缀 / unknown 非空 ID / 旧式 `self:<id>` | `:42-70`；四种情况均通过 | **PASS** |
| target 与 experiencer 分离 | 独立字段 | **PASS** |
| unknown 不进 self 投影 | `:187-195`；`selfEmotions` 只含 self；`primaryForSelf` 只含 self | **PASS** |
| owner/third_party 不进 selfEmotions | 同上 | **PASS** |
| 只有 self 且达阈值才 injectable | `injectable = self && active_candidate` | **PASS** |
| 多情绪/正负/衰减/排序/displayLimit/determinism | 全量测试通过 | **PASS** |
| EI-1 是否接入生产/注入 | 无任何非测试代码 import；`index.js` 未引用 | **NOT RUN（生产）/ PASS（隔离）** |

### 2.3 EI-1 结论

- **代码隔离验收 PASS（本轮在 1572e49 重新执行）**：21/21、324/324、0 fail、0 skip、工作区干净、diff --check 通过。
- **DSHA/负责人设备复验 NOT RUN**。
- **生产集成 NOT RUN**。
- 只能写“代码隔离验收 PASS，待负责人/DSH 设备复验”，不能写“生产通过”。

---

## 3. EI-2 设计逐项审查

文档：`EI-2-PERSISTENCE-DESIGN-01.md` @ `1572e49`，blob `d79bd124167dec45968fc5aece7060017fc75057`，仍是提案。

| # | 审查项 | 结果 | 状态 |
|---|---|---|---|
| 1 | experiencer 与 target 命名空间 | `experiencer_type` / `target_type` 明确；裸 ID、unknown 空 ID、tool 保留；但 owner/third_party 稳定 ID 与旧 target 文本映射未定 | **PASS（结构）/ PARTIAL（ID 策略）** |
| 2 | appraisal + appraisal_items 多情绪模型 | §3.2 统一一条 appraisal + items；items 有 `(appraisal_id,item_index)` 唯一；旧列镜像规则待 EI-2A 锁定 | **PASS（模型）/ PARTIAL（镜像）** |
| 3 | episode 生命周期/ended_at/expires_at/衰减 | §3.3 加了 ended_at/end_reason/episode_revision；但“ended_at 优先”与“较早者决定退出”措辞矛盾 | **PARTIAL / 需裁决** |
| 4 | typed sourceRefs 与 raw→raw_message | §3.4 白名单含 episode/raw_message/legacy；明确 EI-1 仍输出 raw，EI-2A 持久化边界归一化；不能用 EI-1 冒充已实现 | **PASS（设计）/ 实现 NOT RUN** |
| 5 | event/outbox/inbox 幂等/重试/ACK | event dedupe 唯一、outbox idem_key/ack_status、inbox status、payload_sha256 ack 均定义；重试/保留期/ACK 传输仍属未决 | **PASS（结构）/ PARTIAL（运行策略）** |
| 6 | schema_version 与真实 SQLite 结构探测 | §11.6 明确以 sqlite_master/PRAGMA 为准，版本号只辅助；要求三类 fixture | **PASS（设计）/ 实现 NOT RUN** |
| 7 | 旧数据 unknown/self/owner/third_party 分类 | §6.3 四类矩阵；348 条不得批量 self；先 shadow；known-self 证据规则仍不具体 | **PASS（安全默认）/ PARTIAL（可操作性）** |
| 8 | 旧 API 兼容与 shadow-only | §6.5/6.6 旧 API 保留；新投影 shadow-only；未提 `emotion_contract_version`/capabilities | **PASS（EI-2A）/ 后续 API 待补** |
| 9 | 事务原子性/失败重试/timeline 旧缺陷 | §11.1-11.7 识别三连 INSERT 无事务、timeline `session_key`/`self_id`、派生 catch 吞错；§7 有故障注入要求 | **PASS（风险识别）/ 待实现** |
| 10 | EI-2A..EI-2F 阶段门禁 | §8 分阶段清晰；但 outbox/inbox 表归属 2A 还是 2D 未明确 | **PASS（阶段）/ PARTIAL（范围）** |

### 3.1 关键不一致/缺口

1. **confidence 语义字段缺失**：§3.3 只加 `confidence REAL NULL`；§11.2 要求区分“缺失/unknown、规则默认 0.5、规则默认 0.7、校准值”，但 schema 没有 `confidence_kind` / `confidence_source`。`appraisal_items` 也只有 `confidence`。**BLOCKER**。
2. **dedupe_key legacy 回填公式未定义**：§3.1 `dedupe_key TEXT NOT NULL` + 唯一约束，旧行要求“确定性 legacy key 回填”，但没有公式；迁移无法唯一填充。**BLOCKER**。
3. **ended_at/expires_at 优先级措辞矛盾**：§3.3 说 `ended_at` 优先，又说“两者均存在时较早者决定退出”。若 ended_at 晚于 expires_at，哪一个赢？**DESIGN DECISION**。
4. **owner/third_party 稳定 ID 未定**：§9.1/9.2；影响 owner/third_party 持久化与去重，但不阻塞 schema 默认 unknown。**DESIGN DECISION**。
5. **旧 appraisal 多 item 镜像策略未定**：§3.2/§12.2.2；旧 348 条是单 emotion，可回填 1 item，但多 item 时旧列如何镜像需规则。**IMPLEMENTATION REQUIREMENT（EI-2A fixture）**。
6. **raw_message/tool_call 稳定引用来源未定**：§9.3；EI-2A 只建 source_type 列，实际引用可后移。**LATER（EI-2B+）**。
7. **outbox 重试/保留期/撤回语义未定**：§9.6；不阻塞表结构，阻塞 2D 运行。**LATER（EI-2D）**。
8. **API 版本/能力协商未写**：旧 API 兼容有，但 `emotion_contract_version` / `capabilities.emotionV2` 未提；属 2C 读取 API。**LATER（EI-2C）**。

---

## 4. 问题分类

### 4.1 BLOCKER（不解决不能开始 EI-2A）

| ID | Blocker | 影响 | 建议 |
|---|---|---|---|
| **B1** | `confidence_kind` / `confidence_source` 缺失 | schema v3 无法区分 unknown / 规则 0.5 / 规则 0.7 / 校准值；§11.2 的验收无法在 DB 层成立；以后加字段要再迁移 | EI-2A 前加字段（appraisal + appraisal_items），明确枚举与旧行默认 `legacy_default`/`rule_constant` |
| **B2** | 旧 `dedupe_key` 回填公式未定义 | `dedupe_key NOT NULL` + 唯一约束，迁移无法唯一填充；不同实现会生成不同 key | 明确公式（如 `legacy:<event_id>` 或 `source_kind:source_id:hash`），写入迁移报告与 fixture |

> B1/B2 不解决，EI-2A 的 schema/migration 不能冻结。其余问题可并行决策或后移。

### 4.2 DESIGN DECISION（需要负责人/GPT 选择）

| ID | 决策项 | 选项/影响 | 建议 |
|---|---|---|---|
| **D1** | `owner` 稳定 ID | DSH user ID / relationship peer ID / 独立 UUID；影响去重、跨会话、隐私 | 由负责人定；EI-2A 可先允许空/unknown，不阻塞 schema |
| **D2** | `third_party` 身份策略 | 会话内临时 ID / 联系人 ID / 不跨会话；影响去重与误合并 | 先会话内临时 ID + 不跨会话关联，最保守 |
| **D3** | `ended_at` vs `expires_at` | 谁优先；建议“较早者退出，ended_at 只提供显式原因，不延长” | 统一为 earliest；否则测试无法写 |
| **D4** | 旧 348 条 known-self 证据规则 | 全部 unknown（安全，但旧 self 情绪不上屏）/ 按 rule_id 路径标 known-self 候选 shadow / 人工抽检 | 先全部 unknown + shadow 统计；known-self 只做候选，不直接 self |
| **D5** | confidence 0.65/0.45 是否保留 | 保留工程占位 / 重新校准 / 改成 `confidence_kind` 驱动 | 保留占位，标“未校准”；校准放 EI-4 |
| **D6** | `stateFor('self')` legacy fallback | 总是返回旧 state / 无新模型时返回 `legacyFallback:true` / 不返回 | 采用 `legacyFallback:true` 且不自动升级为可信 self 注入 |
| **D7** | EI-2A 是否包含 outbox/inbox 表 | 2A 建表、2D 才运行 / 全放 2D | 建议 2A 只建表并写 schema 测试，运行与 ACK 放 2D |

### 4.3 IMPLEMENTATION REQUIREMENT（EI-2A 内必须完成）

| ID | 要求 |
|---|---|
| I1 | 真实 schema 探测：sqlite_master + PRAGMA；旧/部分扩展/当前三类 fixture；meta 标记只辅助 |
| I2 | `appraisal_items`：旧 appraisal 回填 1 item；多 item 镜像规则；旧列只读镜像、不反向覆盖 |
| I3 | `source_type` 持久化边界归一化：`raw → raw_message`；`legacy` 仅兼容；未知 type 拒绝；fixture |
| I4 | `episode_revision` 回填 1、可发布更新单调递增；outbox idem_key fixture |
| I5 | `dedupe_key` 规范化（trim/大小写/空值拒绝）与唯一约束测试 |
| I6 | `appraisal_version` 唯一索引；旧 NULL/异常行统计与迁移报告 |
| I7 | event+appraisal+items+episode 单事务；故障注入回滚测试 |
| I8 | timeline 旧路径用真实 `self_id` schema 修复/断言；不得用新表迁移掩盖 |
| I9 | 旧 `target`（owner/self/tool）→ target_type/id 映射；无法映射 → unknown |
| I10 | 旧 API `state/emotionAt/emotionTimeline/emotionLine` 输出不变；新表只写/只 shadow，不切换读路径 |
| I11 | 迁移幂等：同副本运行两次结果一致；只增不删；回滚只关新消费者 |

### 4.4 LATER PHASE（EI-2B 以后，不应扩大 EI-2A）

| ID | 内容 | 阶段 |
|---|---|---|
| L1 | appraisal → episode 写入接入、typed refs 落库 | EI-2B |
| L2 | `stateFor(target)`、`emotions[]`、API 版本/能力协商 | EI-2C |
| L3 | outbox/inbox 运行、ACK 传输、重试/保留期/撤回 | EI-2D |
| L4 | DSHA 隔离副本 shadow 统计、unknown/self/owner 覆盖率 | EI-2E |
| L5 | 生产迁移/注入/部署 | EI-2F（需负责人单独授权） |
| L6 | Memory recall 情绪权重、raw_message/tool_call 稳定引用 | 跨模块/EI-3，不在本轮 |

---

## 5. EI-2A 最小范围与明确排除

### 5.1 建议最小 EI-2A（若负责人批准）

1. **只做 schema v3 增量 DDL**：新增字段/表、索引、唯一约束；不删除、不改旧列语义。
2. **只做 migration 脚本 + 副本演练**：v1/v2/meta 不一致三类 fixture；幂等两次；只增不删。
3. **只写不读**：旧 API/旧注入路径完全不变；新表写入只做 shadow，不切换读取。
4. **完成 B1/B2 与 D3 后再冻结 DDL**；D1/D2 可先用空/unknown 占位。
5. **验收**：fixture schema 探测、迁移幂等、旧 API 输出不变、回滚可执行、无生产写入。

### 5.2 明确不属于 EI-2A

- 不接 appraisal→episode 写入（EI-2B）。
- 不做 `stateFor`/新读取 API/注入切换（EI-2C）。
- 不跑 outbox/inbox/ACK/重试（EI-2D）。
- 不做 DSHA shadow 评测（EI-2E）。
- 不做生产迁移/部署/重启/staging（EI-2F）。
- 不改 Memory 仓库、不做 recall 情绪权重。
- 不把旧数据批量标 self；不删除任何历史行。

---

## 6. 结论与回答

### 6.1 EI-1 是否可以正式收口为代码隔离验收完成？

**可以**：当前 HEAD `1572e49` 的代码/测试与 `3a1376` 相同；本轮复跑 21/21、324/324、0 fail、0 skip、status 干净、diff --check 通过。  
**只能写**：“EI-1 代码隔离验收 PASS，待负责人/DSH 设备复验”。  
**不能写**：生产集成 PASS、DSHA 实机 PASS、EI 已形成。

### 6.2 EI-2 设计是否足以进入 EI-2A？

**不足以无条件进入**。文档结构已足够进入下一轮评审，但 EI-2A 前必须先解决：
- **B1** `confidence_kind`/confidence 语义字段；
- **B2** legacy `dedupe_key` 公式；
- **D3** `ended_at`/`expires_at` 优先级。

解决上述三项，并明确 D1/D2 的临时占位策略后，可启动**最小 EI-2A**（schema + migration + fixtures，不切换读写）。若负责人要求 EI-2A 同时包含 outbox/inbox 运行或新读取 API，则范围已超出 2A，应拆分。

### 6.3 还需要负责人决定哪几件事？

1. owner 稳定 ID（D1）。
2. third_party 身份策略（D2）。
3. ended_at/expires_at 优先级（D3）。
4. 旧 348 条 known-self 证据规则（D4）。
5. confidence 0.65/0.45 是否保留为工程占位（D5）。
6. EI-2A 是否只做 schema+migration，还是包含 outbox/inbox 建表/运行（D7）。

### 6.4 如果允许启动 EI-2A，最小实施范围？

见 §5.1：**schema v3 增量 DDL + migration 脚本 + 三类 fixture + 幂等/回滚 + 旧 API 不变；只写不读；无生产写入**。

### 6.5 哪些功能明确不属于 EI-2A？

见 §5.2：EI-2B 写入接入、EI-2C 读取 API/投影、EI-2D outbox/inbox 运行、EI-2E DSHA shadow、EI-2F 生产、Memory 关联/recall 权重。

---

## 7. 未授权事项

- 生产 persona.db / memory.db 写入或迁移；
- 生产安装目录、profile/config 修改；
- 部署、重启、staging；
- 合并 main、接生产注入；
- EI-2A 代码实施（本轮 NOT RUN）；
- Memory 仓库修改或情绪关联实现；
- 把 EI-1 代码隔离验收写成 DSHA/生产 PASS。

---

## 8. 仍需设备或负责人验证

| 项 | 状态 | 说明 |
|---|---|---|
| DSHA 设备/运行时复验 | **NOT RUN** | 本轮只在 Node/隔离 worktree 跑测试 |
| 生产安装是否加载 EI-1 | **NOT RUN** | 生产仍为 main，未改 |
| 负责人对 D1–D7 的裁决 | **WAITING_OWNER** | 尤其 D1/D2/D3/D4/D7 |
| GPT 对 EI-2 文档的最终评审 | **WAITING_GPT** | 本轮只报告，不改文档 |
| EI-2A 授权 | **NOT GRANTED** | 不得自行启动 |

---

## 9. 证据索引

| 结论 | 证据 |
|---|---|
| 当前 HEAD | `git rev-parse HEAD` → `1572e49ce0fd9c713f119ff8300af91db3c2bb1e` |
| 代码/测试 blob | `cf033ec…` / `eb17cb0…`，与 3a1376 相同 |
| 设计 blob | `d79bd124167dec45968fc5aece7060017fc75057` |
| 定向测试 | `/tmp/ei1-1572e49-target.log`：21 / 21 pass / 0 fail / exit 0 |
| 全量测试 | `/tmp/ei1-1572e49-full.log`：324 / 324 pass / 0 fail / exit 0 |
| 工作区 | `git status --short` 空；`git diff --check` 空 |
| 报告 404 核查 | `dda8771` 存在且为 `eade5a2` 祖先；文件 blob `2a5ffb2` 未变；GitHub API 200 |
| confidence 缺口 | 设计 §3.3 `:94` 只有 `confidence REAL`；§11.2 `:268` 要求区分三种语义 |
| dedupe_key 缺口 | 设计 §3.1 `:62-63` 要求 NOT NULL + 唯一 + legacy 回填，但无公式 |
| ended_at 矛盾 | 设计 §3.3 `:99` “ended_at 优先” vs “较早者决定退出” |
| sourceRefs 映射 | 设计 §3.4 `:110`；EI-1 仍输出 raw，EI-2A 持久化边界归一化 |
| 旧数据 shadow | 设计 §6.3 `:206`、§12.2.5 `:296` |
| stateFor fallback | 设计 §9.8 `:252` |
| 事务/timeline/schema | 设计 §11.1 `:262`、§11.3 `:264`、§11.6 `:267`、§7 `:279` |
| EI-2A 阶段 | 设计 §8 `:234-242` |

---

## 10. 边界声明

- 本轮只读审查与文档整理；未修改 EI-1 源码、测试或 EI-2 设计文档。
- 未访问/修改生产 DB、设备 persona.db、profile、生产插件目录。
- 未执行 migration、部署、重启、staging。
- 未合并 main、未接生产注入、未启动 EI-2A。
- 未修改 Memory 仓库或共享 HANDOFF/REPORT。
- 仅新增本报告文件于 `ba-song/dsh-persona-core` 独立分支 `ei/pre-ei2a-review-01`，基于 `1572e49`；不合并 main。
