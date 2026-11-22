# EI-REPORT-0008 · Memory×Persona 契约交叉问题确认

> 仓库：`ba-song/dsh-persona-core`
> 分支：`ei/pre-ei2a-review-01`（基于 `6c5bade`，仅新增本报告）
> 任务：基于 EI-REPORT-0007 与 GPT 统筹决定，确认 `MEMORY-PERSONA-INTEGRATION-CONTRACT-01` 的 7 个交叉问题
> 生成时间：2026-11-22 10:20 (Asia/Shanghai)
> 性质：只读设计确认；不修改源码/schema/测试/分支/生产 DB，不启动 EI-2A。

## 版本历史

| 版本 | 位置 | 时间 | 内容 |
|---|---|---|---|
| EI-REPORT-0007 | persona `ei/pre-ei2a-review-01` | 2026-11-22 | 契约专项评审；兼容性 FAILED |
| EI-REPORT-0008 | 本文件 | 2026-11-22 | 7 个交叉问题的接口/映射/迁移/修复确认 |

---

## 0. 结论速览

| 问题 | 确认 |
|---|---|
| 1. identityOf(header) | **建议提供**；返回 type/id/self_id/valid/reason/self_writable |
| 2. experiencer_type/id 共同接口 | **可以**；但必须与 `speaker_id`、`subject_id` 分离 |
| 3. person:owner / person:contact:* 映射 | **owner/third_party 映射表可定**；owner 仍需 D1 稳定 ID |
| 4. self ID 格式与哨兵 | canonical `self:<uuid>`；`self:unknown` 永远不是有效身份；服务不可用拒绝 |
| 5. confidence 枚举/默认/迁移 | `unknown/rule_default/calibrated/legacy_unclassified`；新默认 unknown；旧行显式 legacy |
| 6. event.confidence | **原始事件分数，不参与门控**；当前代码未读取该列做门控 |
| 7. timeline/三表事务 | 文件与隔离测试可明确；属于独立修复，不混 EI-2A |

**契约兼容性：仍 FAILED/BLOCKED**；本文件只完成设计确认，不是 PASS。

---

## 1. 准确基线

| 对象 | HEAD/值 |
|---|---|
| Persona main | `a84c7badd1e6c971a66b6c39dd4f7ab795df4b90` |
| Persona EI 修复分支 | `8ccb8a922a789d8d15157b9d99f9de0c20c8807b` |
| Persona EI 报告分支 | `ei/pre-ei2a-review-01` @ `6c5bade1f79646d69864ea95a1d8995e5693cb1b` |
| Memory M1 基线（Memory 报告） | `7548e49ed0b8d8673818464325d8e72ec7704b27`（schema v5） |
| Memory validity 分支（本地只读） | `5797324175f345ff82337f409d8406e5256ddfc3` |
| 契约文件 | 未在仓库找到；按任务提供 v1.0 文本评审 |
| Persona 测试 | 本会话 8ccb8a9：21/21、324/324；DSHA/生产 NOT RUN |

---

## 2. 问题 1：identityOf(header) 接口定义

### 2.1 结论

**建议提供**。当前 `selfId()` 只回答“self 行 id”，无法表达 owner/third_party/unknown、有效性和失败原因；`roleOf()` 的 role 是 `persona/work`，不是主体类型。新增只读身份接口是契约落地的必要条件。

### 2.2 返回值（提案）

```js
identityOf(header) => {
  ok: boolean,                  // 服务/DB 是否可用
  experiencer_type: 'self' | 'owner' | 'third_party' | 'unknown',
  experiencer_id: string,       // 裸 ID；unknown 时 ''
  self_id: string | null,       // 完整合法 self:<uuid>；否则 null
  id_strength: 'stable' | 'role_only' | 'none',
  valid: boolean,               // 分类是否可信、可用于归属
  self_writable: boolean,       // 仅 self + 合法 self_id 为 true
  reason: null | 'E_PERSONA_UNAVAILABLE'
        | 'E_PERSONA_IDENTITY_UNKNOWN'
        | 'E_PERSONA_IDENTITY_INVALID'
        | 'E_PERSONA_HEADER_INVALID'
}
```

语义：

| 场景 | ok | type | valid | self_writable | reason |
|---|---|---|---|---|---|
| DB/self 正常，self 行合法 | true | self | true | true | null |
| DB 不可用 | false | unknown | false | false | E_PERSONA_UNAVAILABLE |
| self 行缺失/`self:unknown`/非法 | true | unknown | false | false | E_PERSONA_IDENTITY_UNKNOWN |
| header 缺失/非法 | true | unknown | false | false | E_PERSONA_HEADER_INVALID |
| owner 角色明确且有稳定 ID | true | owner | true | false | null |
| owner 角色明确但无稳定 ID | true | owner | true | false | null（id_strength=role_only） |
| third_party 有稳定 ID | true | third_party | true | false | null |
| 无法可靠判断 | true | unknown | true | false | null（id_strength=none） |

**关键**：`valid` 表示“分类可信”，`self_writable` 才是“能否写 self episode”；二者不能混用。`unknown` 可以是 valid 的 unknown，但绝不能 self_writable。

### 2.3 边界

- `identityOf` 只读，不写 DB、不改变状态。
- 需要新增的来源：owner/third_party 的稳定主体信息。建议在 `session_bindings` 增加 `subject_type/subject_id`（或独立 `session_subjects` 表），由渠道桥在绑定 owner/peer 时写入；否则只能返回 unknown。
- 这是 Persona 侧 schema 设计，不属 EI-2A；未授权前只出接口提案。

---

## 3. 问题 2：experiencer_type/id 共同接口

### 3.1 结论

**可以作为共同接口**，但必须把三个概念分开：

| 概念 | 含义 | 归属 |
|---|---|---|
| `speaker_id` | 原话/消息的说话者（raw 层） | Memory raw |
| `experiencer_type/id` | 谁体验了这个情绪/经历 | Persona ↔ Memory 共同 |
| `subject_id` | 这条记忆/事实“关于谁” | Memory memory 业务 |

`experiencer_type/id` 是契约 §2 的权威身份；`speaker_id` 不能替代它，`subject_id` 也不能替代它。

### 3.2 字段

- `experiencer_type`: `self | owner | third_party | unknown`
- `experiencer_id`: 裸 ID，不含类型前缀；unknown 为空
- `id_strength`: `stable | role_only | none`（Memory `subject_kind` 需要知道能否用于去重）
- `self_id`: 完整 `self:<uuid>`，只对 self 有意义
- Memory 侧建议新增 `experiencer_type/experiencer_id/id_strength`（或把现有 `subject_kind` 定义为这三项）；不要把 `speaker_id` 复用为 experiencer。

### 3.3 兼容

- 旧 `memories.speaker_id='self:<uuid>'` 保留；新 `experiencer_*` 从同一 self ID 派生。
- 旧 raw `person_id` 做 hint，不直接当权威；必须经 `identityOf`/映射校验。
- 旧 `subject`/`subject_id` 保留；不能反向覆盖 `experiencer_*`。

---

## 4. 问题 3：person:owner / person:contact:* 映射

### 4.1 映射表（提案）

| Memory person 值 | 映射 | ID | 条件 |
|---|---|---|---|
| `person:owner` | owner | D1 稳定 owner ID；未定则 `owner` + id_strength=`role_only` | 必须由 owner session/role 验证；不能只凭字符串 |
| `person:contact:qq:<id>`（id=ownerQQ） | owner | D1 owner ID 或 `qq:<id>` | ownerQQ 配置匹配 |
| `person:contact:qq:<id>`（非 owner） | third_party | `qq:<id>` | 有稳定 QQ 号 |
| `person:contact:email:<addr>`（owner email） | owner | D1 owner ID 或 `email:<addr>` | owner email 配置匹配 |
| `person:contact:email:<addr>`（非 owner） | third_party | `email:<addr>` | 有稳定地址 |
| `person:contact:qq:group:<gid>` | third_party（entity） | `group:<gid>` | 群是实体，不是个人；如产品要求可改 unknown |
| 空/未匹配/`person:contact` 无具体 ID | unknown | '' | 不猜 |

### 4.2 规则

1. 先看结构化 `experiencer_type/id`；有则优先。
2. 否则调 `identityOf(header)`；owner/third_party 以其结果为准。
3. 最后才用 `person_id` 字符串映射；映射结果与 `identityOf` 冲突时，**降为 unknown**，不猜。
4. `person:owner` 不是无条件 owner；必须验证 owner 会话/角色；否则不得写 owner episode。
5. `person:contact:*` 到 third_party 的映射可用于 raw 层；episode 写入需要有稳定 ID，否则 unknown。

---

## 5. 问题 4：self ID 格式、哨兵、服务不可用

### 5.1 合法格式

- **canonical（新）**：`^self:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$`（小写 UUID）。
- **legacy（只读兼容）**：`^self:[A-Za-z0-9._-]{1,128}$`，排除 `self:unknown`、空、空白、控制字符；必须对应真实 `self` 行；新写入不得生成 legacy。
- 裸 `experiencer_id`：self 时是 UUID（不含 `self:`）；owner/third_party 是各自 opaque ID；unknown 为空。

### 5.2 `self:unknown`

- 是**哨兵，不是有效身份**；不得写入 `memories`/self episode，不得作为 `self_id` 返回。
- raw archive 可在 `speaker_id='self:unknown'` + `extra.pendingIdentity=true` 保存待回填 raw；该 raw 不得进入 self 注入/self 统计。
- Memory `addEpisode` 必须拒绝 `self:unknown`，抛 `E_PERSONA_IDENTITY_UNKNOWN`。

### 5.3 服务不可用

- 推荐 `selfId()` 在 DB 不可用/self 行缺失时返回 `null`（或抛错），而不是 `self:unknown`；如果保留哨兵，必须同时提供 `identityOf` 的 `valid:false`，Memory 拒绝。
- `identityOf` 返回 `ok:false, reason:E_PERSONA_UNAVAILABLE`；self 行缺失/非法返回 `reason:E_PERSONA_IDENTITY_UNKNOWN`。
- `ensureSelf` 应校验 seedId 格式；当前允许任意 seedId 是缺口。

---

## 6. 问题 5：confidence_kind/source 枚举、默认、迁移

### 6.1 枚举

`confidence_kind`：

| 值 | 含义 | 数值 |
|---|---|---|
| `unknown` | 缺失/不可知 | NULL（items）或旧列占位但不可读 |
| `rule_default` | 规则默认 0.5/0.7，未校准 | 保留数值，仅参考 |
| `calibrated` | 经过校准的模型值 | 保留，附模型/版本 |
| `legacy_unclassified` | 迁移旧数据，来源不可考 | 保留旧数值，不信任 |

`confidence_source`：

- `unknown`
- `rule:recordRuleEpisode`
- `rule:recordAppraisal`
- `rule:<rule_id>`
- `model:<provider>/<model>@<version>`
- `legacy_migration`

### 6.2 默认与迁移

- 新写入默认 `confidence_kind='unknown'`、`confidence_source='unknown'`；`confidence` 在 items 写 NULL；旧 appraisal 列如 NOT NULL 可写占位，但 kind 必须 unknown，消费者先读 kind。
- 只有迁移识别为旧数据的行才写 `legacy_unclassified/legacy_migration`；迁移必须显式 UPDATE，不能依赖普通 INSERT 默认。
- `recordRuleEpisode` 显式写 `rule_default` + `rule:recordRuleEpisode`；`recordAppraisal` 直接调用必须显式传 kind/source，禁止默认 0.5 静默。
- `emotion_appraisal_items` 同样字段/语义。

**与当前设计的冲突**：设计默认 `legacy_unclassified/legacy_migration` 必须改为 `unknown/unknown`；否则契约 §4.1 不满足。

---

## 7. 问题 6：emotion_event.confidence 声明

### 7.1 定位

`emotion_event.confidence` 是**原始事件检测/来源分数**，不是校准概率，不是人格门控依据。

### 7.2 行为约束

- 不参与 self 情绪状态、注入、injectable、关系/人格更新、记忆召回排序、任务优先级。
- 不作为 `confidence_kind='calibrated'` 的证据；不替代 appraisal confidence。
- 当前静态代码：`emotion_event.confidence` 只被 INSERT（`lib/emotion.js:600-605`），无 SELECT/门控读取；`nextState` 的 certainty 用的是 lexicon `score.confidence`（`:382`），不是 event 列。
- Memory 报告称“event confidence 作为 certainty 输入”不准确；应更正为“当前未用于门控”。

### 7.3 未来

若未来要参与门控，必须新增 `event_confidence_kind/source`，定义校准规则和测试；否则保持原始信息定位。

---

## 8. 问题 7：timeline 与三表事务修复

### 8.1 timeline 修复

- 文件：`lib/emotion.js` `applyCoreAppraisal`（约 `:645`）把 `emotion_timeline(session_key,...)` 改为真实 `self_id`；确认所有 timeline INSERT（`lib/emotion.js`）统一用 `self_id`。
- 不再空 catch 吞错；至少 `log.warn` + 可观察计数；若 timeline 是历史必需，考虑与 state 更新同事务并抛错。
- 测试：`tests/emotion.test.mjs` 或新增 `tests/timeline-schema.test.mjs`；用临时 DB 的 `openDb` 真实 schema，调用 `applyCoreAppraisal`，断言 `emotion_timeline` 有 1 行且 `self_id` 正确、trigger 正确、无异常。
- 隔离：临时 DB/fixture；不写生产。

### 8.2 event/appraisal/episode 事务

- 文件：`lib/emotion.js` `recordRuleEpisode`：用 `lib/db.js` 的 `tx()` 包裹 `recordEvent` + `recordAppraisal` + `recordEpisode` 三个 INSERT；`recordEvent/recordAppraisal/recordEpisode` 不自开事务。
- 主链提交后再做 state/core/relationship 派生；派生失败可观察/重试，不回滚主链。
- 测试：新增 `tests/emotion-atomic.test.mjs`（临时 DB）：
  1. 成功路径 event/appraisal/episode 各 1；
  2. 删除/破坏 `emotion_episodes` 后调用，断言 event=0、appraisal=0（回滚）；
  3. 事务失败后库可继续使用。
- 不修改 schema；不混入 EI-2A。

---

## 9. 兼容性矩阵（确认版）

| 契约条 | Persona 侧 | Memory 侧 | 结论 |
|---|---|---|---|
| §2.1 主体分类 | 需 `identityOf` + binding | 需 `subject_kind`/experiencer | **BLOCKED** |
| §2.2 self 身份 | `selfId` 语义需收紧 | 拒绝 sentinel/非法 | **BLOCKED** |
| §2.3 pending | raw pending 可保留 | 不写 self episode | **PARTIAL** |
| §2.4 speaker_id | 不直接管 raw | fresh raw_meta 补列 | **BLOCKED** |
| §3.1 三态 | 不适用 | 单一 helper | **BLOCKED** |
| §3.2 时间 | 不适用 | preference/remembered 补 valid_from | **BLOCKED** |
| §3.3 NULL | 不适用 | valid_from_kind | **BLOCKED** |
| §3.4 superseded | 不适用 | superseded_at | **BLOCKED** |
| §3.5 入口 | 不适用 | 全入口统一 | **BLOCKED** |
| §4.1 新 confidence | 默认改 unknown | 不适用 | **BLOCKED（Persona）** |
| §4.2 旧 legacy | 显式迁移 | 不适用 | **PARTIAL** |
| §4.3 event confidence | 声明原始分数 | 不适用 | **PARTIAL** |
| §4.4 语义分离 | 字段分离 | 不适用 | **PASS（设计）** |
| §5 一致性 | timeline/事务修 | addEpisode 幂等 | **BLOCKED（Persona）** |
| §6 测试 | EI-1 21/21+324/324 | 契约矩阵未跑 | **PARTIAL** |
| §8 PASS | 未满足 | 未满足 | **FAILED** |

---

## 10. 未决问题

1. owner 稳定 ID（D1）仍未定；owner episode 是否允许 `role_only`。
2. Persona `session_bindings` 是否增加 `subject_type/subject_id`（owner/third_party 来源）。
3. Memory schema v6 的 `subject_kind` 与 `experiencer_*` 是同一字段还是并存。
4. `person:contact:qq:group:*` 归 third_party 还是 unknown。
5. `valid_from_kind` 的旧/新判定与迁移矩阵。
6. `superseded_at` 无时间戳历史行的 UNCERTAIN 规则。
7. 报告分支与设计分支不一致（0005 引用 670e5a3，报告分支 d79bd12）。

## 11. 状态

- 本轮设计确认：**READY_FOR_REVIEW**。
- 契约兼容性：**FAILED/BLOCKED**（§2.1/2.2/2.4/3.x/4.1/5 未满足）。
- EI-1：**代码隔离 PASS**（8ccb8a9，21/21、324/324）；DSHA/生产 **NOT RUN**。
- EI-2A：**NOT_STARTED**，未授权。

## 12. 边界

- 只读设计确认；未修改源码/schema/测试/分支/生产 DB。
- 未启动 EI-2A；未部署/重启/staging；未接生产注入。
- 未修改 Memory 仓库；未修改共享 HANDOFF/REPORT。
- 合成 DB/fixture 仅在 `/tmp`。
