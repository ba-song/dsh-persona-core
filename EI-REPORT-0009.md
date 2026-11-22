# PERSONA 专项只读审查报告 · DSH-PERSONA-CONTRACT-V1.1.1-READONLY-REVIEW

> 仓库：`ba-song/dsh-persona-core`
> 审查对象：Persona 当前实现 + 共同契约 v1.1.1 C1–C8
> 审查方式：只读源码、临时 DB 复现、现有测试
> 生成时间：2026-11-22 12:25 (Asia/Shanghai)
> 性质：只读审查；不授权开发、迁移、部署或 EI-2A。

## 0. 结论

- **v1.1.1 权威文本未找到**：仓库、coordination、工作区、专项报告均未发现独立 v1.1.1 文档；只有 Memory 的 v1.1 最终审查（MEMORY-REPORT-0027）。
- 因此按任务要求：**共同契约结论 = BLOCKED**，不能宣称 v1.1.1 已达成一致。
- 按任务给出的 C1–C8 对当前 HEAD 审查：**C1/C2/C4/C5/C7/C8 = REJECT；C3/C6 = BLOCKED（实现缺失）**。
- Persona 当前实现**不能**为 Memory 提供可信、唯一、稳定的 self 身份；`selfId()` 仍返回 `self:unknown`，`identityOf` 不存在。
- EI-2A 仍 **NOT_STARTED**；本任务未改变状态。

## 1. 审查基线

| 项 | 值 |
|---|---|
| 仓库 | `ba-song/dsh-persona-core` |
| main | `a84c7badd1e6c971a66b6c39dd4f7ab795df4b90` |
| EI 修复分支 | `fix/ei1-source-ref-experiencer-contract` @ `8ccb8a922a789d8d15157b9d99f9de0c20c8807b` |
| EI 报告分支 | `ei/pre-ei2a-review-01` @ `695413c353183dfbed26bbc155796fc1c0b32f4c` |
| 审查 worktree | `/tmp/ei1-8ccb8a9`，HEAD `8ccb8a9`，`git status --short` 空 |
| 工作区状态 | clean；`git diff --check` 空 |
| AGENTS | 已读 `/sdcard/DSHA/工作区/AGENTS.md`、项目 `AGENTS.md`；Persona 仓库内无 AGENTS.md |
| Memory M1 | `7548e49ed0b8d8673818464325d8e72ec7704b27`（schema v5） |
| Memory coordination | `6c46433be64206319041fed9aa99db9d3b07db7c`；HANDOFF blob `b210d0a09200fd87e5f0fce0b4f08ded38dfe70a`；REPORT blob `02c430b8417bddd05645cfa6ef18fb8e8d169503` |
| v1.1.1 文本 | **未找到**；MEMORY-REPORT-0027 是 v1.1 最终审查，不是 v1.1.1 |
| 测试 | `node --test tests/emotion-compose.test.mjs` 21/21；`npm test` 324/324；均 exit 0；仅证明现有测试通过，不代表契约通过 |

## 2. C1–C8 逐项结论

| 条款 | 结论 | 证据/说明 |
|---|---|---|
| C1 身份字段语义 | **REJECT** | Persona lib 中 `speaker_id`、`experiencer_type`、`experiencer_id`、`owner_scope`、`scope_type` 均不存在（`git grep` 0 命中）；只有 `emotion_event.subject TEXT`（`lib/db.js:192`）；`experiencer*` 仅 EI-1 纯函数输入（`lib/emotion-compose.js:40-45`），未进 DB/service |
| C2 selfId canonical/null | **REJECT** | `selfId()` 返回 `row()?.id ?? 'self:unknown'`（`lib/service.js:64-69`）；测试也断言 `self:unknown`（`tests/contract.test.mjs:144`）；`ensureSelf` 在 0 active 时新建 self（`lib/self.js:36-41`），非法 seed `abc` 被接受（临时 probe）；多 active 时抛 `E_SELF_CONFLICT`，service 降级为 `self:unknown` |
| C3 identityOf 可信方向 | **BLOCKED** | `identityOf` 不存在（`git grep` 0 命中）；无输入字段、无证据路径、无冲突/伪造检查，无法审查其可信性 |
| C4 binding 与 selfId 同源 | **REJECT** | `bindingOf` 只返回 session_bindings 行（`lib/service.js:126-135`），无 `persona_id===selfId()` 检查；`roleOf` 返回 `persona/work`，不是 self 证明；`bindSession` 不覆盖不同 persona（`lib/bindings.js`）；无失效/解绑/历史 |
| C5 owner/third_party/group | **REJECT** | Persona 无 owner/third_party 身份接口；`roleOf` role 只有 `persona/work`（`lib/bindings.js:14-15`）；`classify` 只有 private/group/subagent；无 `person:owner`/群实体映射；无 role_only 实现 |
| C6 experiencer_evidence | **BLOCKED** | `experiencer_evidence` 不存在；无可信生成路径；`meta.serviceVersion/origin` 未被 Persona 用于身份；binding 无 source/freshness；无法证明 self 证据 |
| C7 subject_updated_at/source | **REJECT** | `session_bindings` 只有 `session_id/persona_id/role/cwd/source/created_at`（`lib/bindings.js:22-29`）；无 `subject_updated_at/subject_source/subject_type/subject_id`；旧 binding 无法判断主体新鲜度 |
| C8 timeline/原子性 | **REJECT** | timeline 写入用 `session_key`（`lib/emotion.js:645`），读取/真实列是 `self_id`（`lib/db.js:124-134`，`emotion.js:1066`）；临时 DB 复现 state 更新、timeline 0。`recordRuleEpisode` 三连 INSERT 无事务（`:652-730`）；删除 episodes 后 event=1/appraisal=1 残留 |

## 3. selfId / identityOf / bindingOf

### selfId

- 正常：返回 `self` 行 id；未强制 canonical UUID。
- DB 不可用/行缺失：`self:unknown`，不是 null。
- self 缺失：`ensureSelf` **新建** self（`lib/self.js:36-41`），不是 null。
- 非法 seed：`ensureSelf` 接受 `abc`（临时 probe），不是 `E_PERSONA_IDENTITY_INVALID`。
- 多个 active：`ensureSelf` 抛 `E_SELF_CONFLICT`；`lib/index.js:112-115` 捕获后 `state.self=null`，service `selfId()` 返回 `self:unknown`。
- 缓存/回退：`state.self` + `selfId()` 无合法性校验；`self:unknown` 可绕过 Memory 门禁。

### identityOf

- 不存在；C3/C6 无法通过。
- 现有 `roleOf` 只返回 `{session_id, persona_id, role, bound}`，没有主体类型/ID/证据/失败原因。
- 不能仅凭 `bindingOf().persona_id` 认定 self（见 C4）。

### bindingOf

- 返回 `{...row, bound:true}`，无 selfId 对照。
- `session_bindings` 可存 `self:other`（测试 `d-persona-bindings`）；同 session 不同 persona 不覆盖旧行。
- 无失效/解绑/历史/更新时间；`source` 是绑定来源，不是主体证据。
- 只有 `bound===true && persona_id===selfId()` 且 selfId 合法才可用于 self；当前未实现该检查。

## 4. owner / third_party / group 边界

- `roleOf` 的 role 是 `persona`/`work`，不能映射 owner/third_party。
- `classify` 只分 private/group/subagent，不判断主体。
- 无 owner role_only 字段；无 `person:owner`/`person:contact:*` 映射；无群实体 `person:contact:qq:group:<gid>`。
- Memory 的 people/contacts 管理 third_party；Persona 未提供可校验的 owner/third_party 身份，Memory 只能 unknown 或自行猜，违反“Memory 不得猜 self”的方向。
- 未发现 Persona 显式把 owner/group 升级为 self 的代码路径；但缺少 owner 接口导致 Memory 可能回退到 self，是**潜在风险**，不是已证实提升路径。

## 5. experencer_evidence（按任务拼写）

- `experiencer_evidence` 字段/函数/列不存在（`git grep` 0 命中）。
- 无“可信生成路径”；`meta.serviceVersion/origin` 未被 Persona 用于身份；`session_bindings.source` 只是 default/subagent。
- 因此 C6 不能 PASS；普通 PATCH 是否能改证据无法评估，因为不存在。

## 6. session_bindings 字段与旧数据兼容

当前表：`session_id, persona_id, role, cwd, source, created_at`（`lib/bindings.js:22-29`）。

缺失：`subject_type, subject_id, subject_updated_at, subject_source`。

- 旧 binding 无主体字段 → 只能 unknown，不能认 owner/third_party。
- 无 `updated_at` → 无法判断陈旧；旧行可能长期复用。
- 无解绑/失效/历史；`bindSession` 对同 session 不同 persona 不覆盖旧行。
- Channel Bridge 写入协议未在 Persona 定义；Persona `bindSession` 只在 agent mount 写，未验证 Bridge 来源。
- 结论：C7 REJECT；Channel Bridge 与 Persona 的职责边界未闭合。

## 7. timeline 与多表原子性

- timeline 写入：`lib/emotion.js:645` `INSERT INTO emotion_timeline(session_key,...)`；真实 schema 是 `self_id`（`lib/db.js:124-134`）。空 catch 吞错（`:647`）。
- 复现（临时 DB）：`applyCoreAppraisal` 后 `emotion_state` 更新成功，`emotion_timeline` 前后均 0。
- 多表写入：`recordRuleEpisode` 依次 `recordEvent`/`recordAppraisal`/`recordEpisode`，无 `tx()`（`lib/emotion.js:652-730`）。删除 episodes 表后复现 event=1、appraisal=1 残留。
- self 身份变化：timeline 按 `self_id` 读；历史行保留旧 self，无迁移/审计；当前无身份切换流程。
- 错误可能扩散：timeline 静默缺失影响 `why`/`emotionTimeline`；event/appraisal 半成品影响后续数据；需独立修复，不混 EI-2A。

## 8. addEpisode 错误语义

Memory M1 `lib/service.js`：

- `personaSelfId()` 只判空，接受任意非空；`self:unknown` 被当有效（`:191-199`）。
- `addEpisode` 只判 `!selfId`（`:291-294`），随后 `speakerId:selfId`（`:321`）。
- `E_PERSONA_IDENTITY_UNKNOWN` 不存在（M1 `git grep` 0）；只有 `E_PERSONA_UNAVAILABLE`。
- 非法 `abc` 被规范成 `self:abc` 写入（Memory 报告 0024/0026 实测）。
- 多 active `E_SELF_CONFLICT` 来自 Persona `ensureSelf`，不是 addEpisode；Persona 服务降级后 `selfId=self:unknown`，仍会写入。
- 无异常吞掉路径导致“继续写”；但错误码/拒绝语义与契约不符。

## 9. 测试结果与未覆盖

本轮执行（HEAD 8ccb8a9）：

- `node --test tests/emotion-compose.test.mjs` → 21/21，exit 0。
- `npm test` → 324/324，exit 0。
- `git status --short` 空；`git diff --check` 空。

但现有测试**不覆盖** C1–C8：

- `tests/contract.test.mjs:144` 断言 `selfId()` 返回 `self:unknown`，与 C2 冲突。
- 无 `identityOf`/`experiencer_evidence`/`subject_updated_at`/`subject_source` 测试。
- 无 owner/third_party/group 边界测试。
- 无 timeline `applyCoreAppraisal` 写入测试；无 `recordRuleEpisode` 回滚测试。
- Memory addEpisode 的 self:unknown 门禁无测试。
- Memory 全量/契约测试未本轮执行；Mark **NOT RUN**。

## 10. 与 Memory 共同契约的差异

| 字段/行为 | Persona | Memory v1.1 方向 | 差异 |
|---|---|---|---|
| `experiencer_type/id` | 仅 EI-1 纯函数输入，无 DB/service | M1 计划 v6 增加 | Persona 未提供持久化/服务接口 |
| `speaker_id` | 无 | raw_meta/memories 有 | Persona 不提供 |
| `selfId` | `self:unknown` 哨兵 | 需要 canonical/null | 直接冲突 |
| `identityOf` | 无 | 需要可信身份 | 缺失 |
| `bindingOf` | 无 selfId 校验 | 需要同源 | 缺失 |
| `owner/third_party` | 无接口 | 需要 mapping | 缺失 |
| `experiencer_evidence` | 无 | 需要不可 PATCH 证据 | 缺失 |
| `subject_updated_at/source` | 无 | 需要 | 缺失 |
| timeline/事务 | 错列/非原子 | 需要一致 | 缺陷 |

## 11. 已确认缺陷、潜在缺陷、证据不足

**已确认缺陷（代码/复现）：**
1. selfId 返回 `self:unknown`（DB 不可用/行缺失/多 active）。
2. self 缺失时 ensureSelf 新建 self；非法 seed 被接受。
3. bindingOf 无 selfId 校验。
4. `identityOf`/`experiencer_evidence`/`subject_*` 不存在。
5. timeline `session_key` 错列，静默失败。
6. `recordRuleEpisode` 非原子，部分写入。
7. Memory addEpisode 接受 `self:unknown`，无 `E_PERSONA_IDENTITY_UNKNOWN`。

**潜在缺陷：**
- 无 owner/third_party 接口，Memory 可能回退到 self；无显式提升路径，但风险存在。
- session binding 无更新时间/失效，旧绑定可能长期复用。
- 无 canonical self 校验，非法 seed/旧行可进入服务。

**证据不足：**
- v1.1.1 权威文本缺失，无法核对 10 条之外。
- Memory 全量/契约测试未跑；Memory M1 vs validity 分支行为可能差异。
- 生产安装/DSHA 未验证。

## 12. 对共同契约的结论

- **结论：BLOCKED**（v1.1.1 权威文本未找到；当前实现 C1–C8 多项不满足）。
- 若仅按当前实现判定：**REJECT**（C1/C2/C4/C5/C7/C8；C3/C6 缺失）。
- 不是 ACCEPT，也不是 ACCEPT_WITH_CHANGES：文本未定 + 实现未达。
- EI-2A 仍 NOT_STARTED。

## 13. 进入后续实施评审前必须解决的问题

1. 提供 v1.1.1 权威全文，明确 C1–C8 最终措辞。
2. Persona 定义 `identityOf`（即使先只返回 self/unknown）并冻结 v1 返回结构。
3. `selfId` 改 canonical/null；`ensureSelf` 非法 seed/多 active 错误语义。
4. `bindingOf` 与 selfId 同源校验；owner/third_party unknown 降级。
5. `session_bindings` v3 字段与 Channel Bridge 写入协议；旧行 unknown。
6. `experiencer_evidence` 可信来源/不可 PATCH；owner role_only 不写稳定身份。
7. timeline `self_id` 修复；event/appraisal/episode 单事务；独立测试。
8. Memory addEpisode 拒绝 self:unknown/非法，新增 `E_PERSONA_IDENTITY_UNKNOWN`；契约测试矩阵。
9. D1 owner ID、owner episode BLOCKED 策略、Memory v6 接口冻结。
10. 报告/设计分支同步；所有测试在准确 HEAD/临时 DB 复跑。
