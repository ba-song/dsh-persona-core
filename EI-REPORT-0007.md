# EI-REPORT-0007 · Memory×Persona 集成契约专项评审

> 仓库：`ba-song/dsh-persona-core`
> 分支：`ei/contract-review-01`（基于 `e6068c2`，仅新增本报告）
> 任务：`MEMORY-PERSONA-INTEGRATION-CONTRACT-01`
> 生成时间：2026-11-22 10:00 (Asia/Shanghai)
> 性质：只读评审、隔离复现与报告；不授权 EI-2A、schema 迁移、生产写入、部署或重启。

## 版本历史

| 版本 | 位置 | 时间 | 内容 |
|---|---|---|---|
| EI-REPORT-0006 | persona `ei/pre-ei2a-review-01` | 2026-11-22 | 主线复核；B1 residual、分支不一致 |
| EI-REPORT-0007 | 本文件 | 2026-11-22 | Memory×Persona 契约专项评审 |

---

## 0. 结论速览

| 维度 | 结论 |
|---|---|
| 契约文本方向 | **PARTIAL PASS**：目标清楚；需补字段映射、三态 API、错误语义 |
| Persona/EI 侧符合性 | **FAIL**：`self:unknown` 被 Memory 当有效身份写入；confidence 新数据默认 legacy |
| Memory 侧符合性 | **FAIL（待 Memory 负责人确认）**：fresh `raw_meta` 无 speaker_id；NULL valid_from 被当有效；入口未完全统一 |
| 契约 PASS 标准 | **FAIL**：第 1/2/3/4 条当前不满足 |
| 测试矩阵 | **PARTIAL/NOT RUN**：Persona 侧本轮实测；Memory 全量未复跑；契约新增用例多数未实现 |
| 生产/设备 | **NOT RUN**；未触碰生产 DB/设备 |

**总评**：契约作为讨论基线可用，但当前不能标记 PASS，也不能据此开始 EI-2A 或生产迁移。

---

## 1. 基线与范围

| 项 | 实测 |
|---|---|
| Persona main | `a84c7badd1e6c971a66b6c39dd4f7ab795df4b90` |
| Persona fix 分支 | `8ccb8a922a789d8d15157b9d99f9de0c20c8807b` |
| Persona EI 报告分支 | `e6068c24136b2740521d8061c113eca224bdafc2` |
| Memory main | `752cd0861e9c86c9f7be4bdf18302fa72a3b95dd` |
| Memory validity 分支 | `5797324175f345ff82337f409d8406e5256ddfc3`（本地只读 clone） |
| Memory schema_version | 5（当前 validity 分支） |
| Persona source/tests blob | `cf033ec…` / `eb17cb0…` |
| 契约文件 | 未在 Persona/Memory 仓库中找到同名文件；本轮按任务提供的 v1.0 文本评审 |

---

## 2. 契约 §2 身份：核验结果

| 契约要求 | 当前实现 | 状态 |
|---|---|---|
| §2.1 self/owner/third_party/unknown | Persona 有 `selfId()`/`roleOf()`；Memory `raw_meta` 有 `speaker`/`person_id`，`memories.speaker_id`；无统一枚举映射 | **FAIL（映射未定义）** |
| §2.2 self 身份必须有效，否则拒绝 | Persona `selfId()` 在 DB 不可用时返回 **`self:unknown`**（`lib/service.js:64-69`）；测试也断言该回退（`tests/contract.test.mjs:144`）。Memory `personaSelfId()` 只判空，接受任意非空字符串（`lib/service.js:191-199`）；`addEpisode` 只判 `!selfId`（`:291-294`），随后写 `speakerId: selfId`（`:321`） | **FAIL** |
| §2.2 不得伪造/静默写未知身份 | 合成 Persona `selfId=()=>'self:unknown'`，`addEpisode` 实测返回 id=1，`memories.speaker_id='self:unknown'` | **FAIL（已复现）** |
| §2.2 明确错误码 | 只有 `E_PERSONA_UNAVAILABLE`；`E_PERSONA_IDENTITY_UNKNOWN` 未实现（全仓 grep 0 命中） | **FAIL** |
| §2.3 pending/unknown 不进入 self 注入 | raw archive 取不到 selfId 时写 `speaker_id='self:unknown'` + `extra.pendingIdentity=true`（`archive.js:454-458`）；`selfid.js` 有回填，但契约要求的 pending 独立语义/禁止注入未标准化 | **PARTIAL（需 Memory 确认）** |
| §2.4 speaker_id/self_id 一致 | `memories.speaker_id` 存 `self:<uuid>`；但 fresh `raw_meta` 的 CREATE 没有 `speaker_id`（`archive.js:174-177`），后续 ALTER 也只补 raw_text/extra/cwd/person_id（`:182-185`）。新建临时 DB 实测 `has_speaker_id=false` | **FAIL（M1 fresh DB）** |
| 旧 DB 兼容/迁移/回填 | 写路径按列存在降级（`archive.js:470-484`），但没有 fresh DB 标准字段/迁移/回填失败显式状态 | **FAIL/PARTIAL** |

**补充**：
- `raw_meta` 的 user 行 `speaker_id=''`（`archive.js:460-461`），身份主要在 `person_id`；`personOfUser()` 返回 `person:owner` / `person:contact:...`，与契约的 `owner/third_party` 枚举没有显式映射。
- `addEpisode` 只写 `speakerId=selfId`；`subjectId` 是自由文本（`:310`），没有 owner/third_party/unknown 的 `experiencer_type` 参数。契约 §2.1 的“每段经历区分主体”在 episode 写入 API 上没有闭合。

---

## 3. 契约 §3 有效性：核验结果

| 契约要求 | 当前实现 | 状态 |
|---|---|---|
| §3.1 VALID/INVALID/UNCERTAIN 三态 | `validity.js` 输出 SQL 片段；`isValidAt()` 返回 **boolean**（`:248-272`），uncertain 被折叠成 false；另有 `uncertaintySql()` 单独标记 | **FAIL（无统一三态 API）** |
| §3.2 当前/历史时间规则 | `current` 用 `valid_from<=at`、`valid_to>at`；`asOfHistory` 用 `COALESCE(valid_from, created_at_epoch)` 近似 | **PASS（基本规则）/ PARTIAL（近似标记）** |
| §3.3 NULL valid_from 区分旧/新 | `current` 把 `valid_from IS NULL` 当有效（`validity.js:177-182`）；`asOfHistory` 用 created_at 近似（`:186-188`）；`temporal_kind` 没有参与判定 | **FAIL（无法区分 legacy NULL / new unknown）** |
| §3.3 新数据 NULL = UNCERTAIN | 合成 episode `valid_from=NULL, temporal_kind='unknown'` 仍会被 current validity 包含；`addEpisode` 实测写入该形态 | **FAIL（已复现）** |
| §3.4 superseded 规则 | current 强制 `superseded_by` 为空；asOfHistory guard 允许有 valid_to 的历史；superseded-without-end 进 uncertain（`uncertaintySql`） | **PASS（静态）/ NOT RUN（Memory 全量）** |
| §3.5 所有入口统一 | `preference`/`remembered`/`recall`/`graph`/`event-chain`/`p4` 使用 `validitySql`；但 `episodeRecent` 只按 `status='active'`（`service.js:270-272`）；`rules.js:112` 自写 SQL；`session-index.js:41,67` 只用 valid_to | **FAIL（入口未统一）** |
| 时间格式异常 | `validitySql` 只校验 `at` 是有限正数；行内 `valid_from/valid_to` 类型未显式校验，依赖 SQLite 比较 | **PARTIAL（需 Memory 规则）** |

**补充**：`validitySql` 的 current 条件与契约 §3.3 直接冲突；如果现有 schema 无法区分旧/新 NULL，契约要求的“先提出兼容设计”尚未出现。

---

## 4. 契约 §4 置信度：核验结果

| 契约要求 | 当前实现/设计 | 状态 |
|---|---|---|
| §4.1 新数据缺失 → `unknown/unknown` | Persona EI-2 设计 `confidence_kind DEFAULT 'legacy_unclassified'`、`confidence_source DEFAULT 'legacy_migration'`（`EI-2-PERSISTENCE-DESIGN-01.md:80-81`）；普通 INSERT 漏传会落 legacy | **FAIL（设计默认值与契约冲突）** |
| §4.2 只有历史迁移可 legacy | 设计默认对**所有**未显式传值的新行生效；没有“迁移显式标记、普通 INSERT 不允许 legacy”的 DB/应用约束 | **FAIL/PARTIAL** |
| §4.3 event.confidence 不得单独门控 | `emotion_event.confidence` 仍是无 kind/source 的旧列（`lib/db.js:186-202`）；设计未声明它是原始事件信息还是校准值；代码当前没有用它做门控（静态检查） | **PARTIAL（需明确）** |
| §4.4 unknown≠低置信 / 规则默认≠校准 | `confidence_kind` 枚举已定义；但默认值和 `recordAppraisal` 默认 0.5、`recordRuleEpisode` 默认 0.7 仍会让“缺失”变成数值 | **FAIL/PARTIAL** |

**结论**：契约 §4.1 与 Persona 设计默认值直接冲突；这是 Persona/EI 侧必须修的设计 blocker，不是 Memory 侧问题。

---

## 5. 契约 §5 一致性：核验结果

| 项 | 当前证据 | 状态 |
|---|---|---|
| event/appraisal/episode 事务 | `recordRuleEpisode` 三连 INSERT 无统一事务；合成 DB 删除 episodes 后复现 event=1、appraisal=1 残留 | **FAIL（已复现；修复 NOT RUN）** |
| timeline 字段 | `applyCoreAppraisal` 写 `session_key`，真实表是 `self_id`；合成 DB 复现 state 更新但 timeline=0 | **FAIL（已复现；修复 NOT RUN）** |
| 身份失败提前终止 | `addEpisode` 只在 persona 缺失/空串时拒绝；`self:unknown` 继续写 | **FAIL（已复现）** |
| 重试/去重 | `addEpisode` 有 dedupeKey；但 self:unknown 写入的幂等键/回填语义未定义 | **PARTIAL** |
| 错误被吞 | timeline 写入被空 catch 吞；event 主链错误会抛，但派生 state/core/relationship 仍 catch | **FAIL（已知）** |

契约 §5 已明确“timeline/原子性列为独立修复，不混入 EI-2A”；方向正确，但它们是数据正确性 blocker，修复前不能声称契约通过。

---

## 6. 契约 §6 测试矩阵评估

| 组 | 覆盖情况 | 状态 |
|---|---|---|
| 身份：Persona 正常/不可用/`self:unknown`/空/格式错误 | `tests/contract.test.mjs` 只覆盖无 persona/空；没有 `self:unknown` addEpisode 用例；`tests/archive-speaker.test.mjs` 只覆盖 raw pending，且手动建表含 speaker_id | **NOT RUN/缺口** |
| owner/third_party 不误认 self | 没有 addEpisode 的 owner/third_party 写入用例 | **NOT RUN** |
| 时间：future/current/expired/NULL/异常/superseded/asOf | `validity.test.mjs`/integration 有基础；没有“新 NULL vs 旧 NULL”用例；episodeRecent/rules/session-index 未纳入统一矩阵 | **PARTIAL** |
| 置信度：新缺失/显式 unknown/legacy/已有值/event | Persona EI-1 测试覆盖 confidence 分类；没有 EI-2 新字段默认值测试（字段尚未实现） | **NOT RUN** |
| 一致性：中途失败/timeline/重试/schema 三态 | 合成复现已做；Migration/契约测试未实现 | **PARTIAL/NOT RUN** |

**结论**：契约的测试矩阵是必要的，但当前实现和测试没有覆盖关键反例（self:unknown、fresh raw_meta、new NULL、custom entry points、B1 defaults）。

---

## 7. 契约通过标准逐条判定

| §8 标准 | 判定 | 说明 |
|---|---|---|
| 1. 两个专项负责人字段/语义无冲突 | **FAIL/WAITING_AGENT** | Persona 侧已发现 3 个冲突；Memory 负责人尚未签署 |
| 2. 所有入口一致有效性 | **FAIL** | episodeRecent/rules/session-index 未统一；NULL 语义冲突 |
| 3. unknown 不能写入 self episode | **FAIL** | `self:unknown` 实测写入 `memories.speaker_id` |
| 4. 新情绪记录不被默认 legacy | **FAIL** | Persona 设计默认 `legacy_unclassified/legacy_migration` |
| 5. 历史替代关系正确 | **PARTIAL** | 代码有 current/guard/uncertain 规则，但未本轮复跑 Memory 全量 |
| 6. 准确 HEAD/临时 DB 测试通过 | **PARTIAL** | Persona 21/21、324/324 本轮通过；Memory/契约矩阵 NOT RUN |
| 7. 迁移/设备/生产独立授权 | **PASS** | 本轮未触碰生产；边界声明清楚 |

**因此：契约当前不能标记 PASS。**

---

## 8. 必须修改项（按优先级）

### BLOCKER（契约 PASS 前必须解决）

1. **Identity**：Memory `addEpisode` 必须拒绝 `self:unknown`、空、非 `self:<uuid>` 格式；新增 `E_PERSONA_IDENTITY_UNKNOWN`；Persona `selfId()` 的 sentinel 不能被当成有效 ID。
2. **Identity mapping**：明确 `self/owner/third_party/unknown` 与 Memory `speaker`/`speaker_id`/`person_id`/`subject` 的映射；episode 写入 API 需要 `experiencer_type`（或等价字段），不能只写 self。
3. **Fresh raw_meta**：在 fresh DB DDL 中补 `speaker_id`（或明确不使用），并定义旧 DB 迁移/回填/失败状态；不能靠“列不存在就降级”。
4. **Validity NULL**：明确旧 NULL=无下限、新 NULL=unknown；schema/`temporal_kind` 区分；`validitySql` 不能把所有 NULL 当有效；提供三态判定 API。
5. **Entry unification**：`episodeRecent`、`rules`、`session-index` 等必须调用统一 validity helper，或明确排除并写理由。
6. **Confidence defaults**：Persona EI-2 设计把默认改为 `unknown/unknown`，旧行迁移显式 legacy；`emotion_event.confidence` 明确“不参与门控”或加 kind/source。
7. **Timeline/atomicity**：作为独立修复先解决；契约 §5 已列为独立工作，不能以 EI-2A schema 掩盖。

### 需要 Memory 专项负责人确认

- `person_id` 的 `person:owner`/`person:contact:...` 到 owner/third_party 的映射。
- 新旧 NULL 的兼容策略与迁移矩阵。
- `valid_from`/`valid_to` 格式异常的统一错误。
- `episodeRecent`/`rules`/`session-index` 是否属于 §3.5 的注入路径，以及统一方式。
- `raw_meta.speaker_id` fresh DB 修复方案。

### 需要 GPT/负责人决定

- owner/third_party 身份策略（Persona D1/D2）。
- `emotion_event.confidence` 的语义（原始信息 vs 校准值）。
- 契约 §2.3 pending 队列是否本版本实现（当前 raw pending 只是临时语义）。
- EI-2A 是否仍等待上述修复后再授权。

---

## 9. 最小后续工作包

1. **WP1（P0）**：Memory 修 `addEpisode` 身份校验 + fresh raw_meta speaker_id；Persona 保持 sentinel 但 Memory 拒绝。
2. **WP2（P0）**：Validity 三态/NULL 语义 + 入口统一；先写临时 DB fixture，不改生产。
3. **WP3（P0）**：Persona EI-2 设计默认值改为 unknown/unknown；event confidence 明确。
4. **WP4（P1）**：contract test matrix 落到临时 DB；覆盖 self:unknown、owner/third_party、fresh schema、new NULL、入口一致性。
5. **WP5（P1）**：timeline/原子性独立修复。
6. **WP6**：全部通过后，再评审契约 PASS；EI-2A 仍单独授权。

---

## 10. 边界与副作用

- 只读评审；Persona 测试在临时 worktree；Memory 只读 clone；合成 DB 在 `/tmp`。
- 未写生产 persona.db/memory.db；未改生产安装、profile、config；未部署/重启/staging。
- 未修改 Memory 仓库；未修改 Persona 源码/测试/设计文档；未修改共享 HANDOFF/REPORT。
- 仅新增本报告文件于 Persona 报告分支。
