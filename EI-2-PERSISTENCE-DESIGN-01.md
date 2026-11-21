# EI-2 持久化与跨模块关联设计（提案 01）

> 仓库：`ba-song/dsh-persona-core`  
> 设计基线：`main` = `a84c7badd1e6c971a66b6c39dd4f7ab795df4b90`；EI-1 分支相对 main ahead 9 commits。  
> 性质：**设计提案，不是已批准迁移，也不是生产实施授权。** 本文只定义兼容式演进方案；不改生产 DB、不部署、不重启、不改变真实情绪状态。

## 0. 设计目标

在保留 persona-core 现有身份、情绪状态、事件、评估和 episode 数据的前提下，建立可区分“谁体验情绪、情绪指向谁、由什么证据产生”的多情绪模型，并为 memory-core 提供可追溯、可撤回、可降级的关联接口。

目标不是用 56 种组合或固定标签表限制情绪表达。基础情绪词典只作为分类入口；复合情绪可由多个并存 episode 表达。正负情绪不互相抵消。衰减只影响当前投影，不删除事件、评估、episode 或来源证据。

## 1. 当前已证实的代码事实

1. `lib/db.js` 当前 `SCHEMA_VERSION=2`，但已创建 `emotion_event`、`emotion_appraisal`、`emotion_episodes` 等表；README 也说明 `meta.schema_version` 仍为 2，但实际数据结构包含后续新增表。
2. 现有 `emotion_event` 有 `self_id, actor, subject, target, source_ref, payload_json, confidence` 等字段；`self_id` 是 persona 主体键，不等于情绪体验者。
3. 现有 `emotion_appraisal` 通过 `event_id` 关联事件，有 `emotion/intensity/target/confidence/accepted/source` 等字段，但没有显式 experiencer 命名空间。
4. 现有 `emotion_episodes` 有 `self_id, at, emotion, intensity, cause, target, half_life_s, expires_at, appraisal_id, msg_ref`，缺少 experiencer、目标类型、独立来源集合和结束原因。
5. EI-1 的 `lib/emotion-compose.js` 是纯函数投影层，尚未接入 DB、appraisal、注入或 memory。当前缺失 experiencer 时默认 `self`，且将 episode/appraisal/source ID 混装到 `sourceIds`。
6. 旧 emotion_state / timeline / points 与新 event/appraisal/episode 并存，必须保持既有 API 和旧表可用，不能一次性替换旧状态模型。

## 2. 核心语义：身份与对象必须分开

### 2.1 Experiencer（体验者）

采用命名空间二元组：

- `experiencer_type`: `self | owner | third_party | unknown`
- `experiencer_id`: 稳定主体 ID；self/owner 可用各自稳定 ID，third_party 必须有可区分 ID；unknown 时为空。

解释：
- `self`：汐自身真实体验的情绪。
- `owner`：主人表达或可可靠归因给主人的情绪；这是对主人的情绪理解，不自动成为汐的自我状态。
- `third_party`：对话中第三方的情绪。
- `unknown`：证据不足，不能猜测体验者。

**禁止默认 experiencer=self。** 历史记录没有明确证据时迁移为 unknown；不得仅因为记录位于汐的 persona.db 就推断为汐的情绪。

### 2.2 Target（情绪指向对象）

采用独立命名空间：

- `target_type`: `self | owner | third_party | object | situation | unknown`
- `target_id`: 对应稳定 ID；无法识别时为空。

例子：
- 汐因主人夸奖而开心：experiencer=self，target=owner。
- 汐担心主人：experiencer=self，target=owner。
- 汐理解主人正在难过：experiencer=owner，target=unknown 或实际对象。
- 主人提到朋友很愤怒：experiencer=third_party，target=unknown/对象。

`self_id` 继续只表示该 persona DB 的所属人格，不参与上述体验者推断。

## 3. 持久化模型（兼容式 v3 提案）

不删除、不重命名现有表。新增字段全部允许旧行安全落到 unknown；迁移只增不删。

### 3.1 emotion_event：原始情绪相关事件

保留现有字段，新增：
- `actor_type TEXT NOT NULL DEFAULT 'unknown'`
- `actor_id TEXT NOT NULL DEFAULT ''`
- `occurred_at INTEGER`（原始发生时间；旧行可回填 `at`）
- `source_kind TEXT NOT NULL DEFAULT 'legacy'`
- `source_id TEXT NOT NULL DEFAULT ''`

`actor` / `subject` / `target` 旧文本列继续保留供兼容和展示；新代码不得仅凭自由文本做身份授权或跨插件 join。事件记录描述“发生了什么”，不等于情绪归属已经确定。

### 3.2 emotion_appraisal：一次事件的一个情绪判断

新增：
- `experiencer_type TEXT NOT NULL DEFAULT 'unknown'`
- `experiencer_id TEXT NOT NULL DEFAULT ''`
- `target_type TEXT NOT NULL DEFAULT 'unknown'`
- `target_id TEXT NOT NULL DEFAULT ''`
- `evidence_json TEXT NOT NULL DEFAULT '{}'`

一条事件允许产生多条 appraisal；每条 appraisal 表达一个情绪维度/标签，不做正负抵消。保留 `accepted`，但新接口应区分 accepted、rejected、needs_review，旧 integer 列仍兼容（具体映射在迁移实现前由测试锁定）。

`evidence_json` 仅保存可追溯的规则/观察字段和来源引用，不保存私有思维链；原始消息正文仍按既有 provenance 策略管理。

### 3.3 emotion_episodes：持续情绪体验

新增：
- `experiencer_type TEXT NOT NULL DEFAULT 'unknown'`
- `experiencer_id TEXT NOT NULL DEFAULT ''`
- `target_type TEXT NOT NULL DEFAULT 'unknown'`
- `target_id TEXT NOT NULL DEFAULT ''`
- `confidence REAL`（允许 NULL 表示未知，不得自动补成 1）
- `ended_at INTEGER`
- `end_reason TEXT NOT NULL DEFAULT ''`

保留既有 `at/emotion/intensity/cause/target/half_life_s/expires_at/appraisal_id/msg_ref`，避免破坏旧查询。旧 `target` 字段继续作为兼容展示文本；新逻辑以 target_type/id 为准。

episode 表示持续体验，不是当前心情快照。自然到期只使其退出 active projection；不删除历史行。显式结束写 `ended_at/end_reason`，不物理删除。

### 3.4 emotion_episode_sources：类型化来源关联

新增关联表：
- `id INTEGER PRIMARY KEY`
- `episode_id INTEGER NOT NULL`
- `source_type TEXT NOT NULL`（建议白名单：event、appraisal、raw_message、tool_call、memory、external）
- `source_id TEXT NOT NULL`
- `role TEXT NOT NULL DEFAULT 'evidence'`（evidence、trigger、context、corroboration）
- `created_at INTEGER NOT NULL`
- 唯一约束 `(episode_id, source_type, source_id, role)`

采用文本 source_id 是因为不同来源表的 ID 域不共享；禁止将不同表的裸整数塞进一个无类型数组。写入层按 source_type 校验可访问性；暂不使用跨表多态外键。

EI-1 输出保留 `sourceIds` 仅作兼容字段；新契约使用 `sourceRefs: [{type,id,role}]`。新逻辑不得把 sourceIds 当成可反查的权威来源。

## 4. Active Emotion Projection（运行时投影）

不将衰减后的值覆盖回 episode。每次读取按固定 `now` 对未结束且未过期 episode 计算投影：

`decayedIntensity = intensity * 0.5 ^ (max(0, now - at) / (half_life_s * 1000))`

投影分组键：
`(experiencer_type, experiencer_id, target_type, target_id, emotion)`

规则：
1. 同一分组多 episode 默认取最大衰减强度，不直接求和；来源 refs 合并去重。
2. 不同情绪标签并存，正负不净额抵消。
3. unknown experiencer 保留在 unknown 组；不得注入为汐自己的情绪。
4. 只有 experiencer=self 且达到可信度门槛的投影，才可影响汐自身语气/自我状态；owner/third_party 投影只能作为理解对象的上下文。
5. 任何投影都不能改变事实、记忆有效性、权限判断或工具授权。
6. displayLimit 只控制展示，不得丢弃底层完整集合。
7. 时间、阈值、衰减参数必须可注入测试，确保纯函数确定性。

## 5. Persona ↔ Memory 跨插件接口

采用单向、版本化、可重试的事件契约，不共享数据库、不让两个插件互相写对方的表。

### Persona outbox（新增）

`emotion_outbox`：
- `event_id TEXT PRIMARY KEY`（UUID）
- `contract_version INTEGER NOT NULL`
- `event_type TEXT NOT NULL`（emotion.episode.created / updated / ended）
- `payload_json TEXT NOT NULL`
- `created_at INTEGER NOT NULL`
- `delivered_at INTEGER`
- `attempts INTEGER NOT NULL DEFAULT 0`
- `last_error TEXT NOT NULL DEFAULT ''`

episode 与 outbox 必须在同一 persona DB 事务中写入。发送失败不回滚已保存的 episode；outbox 保留待重试。

### Memory inbox（memory-core 侧新增，需独立仓库设计）

`persona_emotion_inbox`：
- `event_id TEXT PRIMARY KEY`
- `contract_version INTEGER NOT NULL`
- `event_type TEXT NOT NULL`
- `payload_json TEXT NOT NULL`
- `received_at INTEGER NOT NULL`
- `processed_at INTEGER`
- `status TEXT NOT NULL DEFAULT 'pending'`
- `last_error TEXT NOT NULL DEFAULT ''`

Memory 侧只存情绪关联和可检索的结构化摘要，不把情绪作为事实权威。接收必须幂等；相同 event_id 重放不得重复关联。

### 最小 payload v1

```json
{
  "contractVersion": 1,
  "eventId": "uuid",
  "eventType": "emotion.episode.created",
  "episode": {
    "id": "episode:123",
    "experiencer": {"type": "self", "id": "self:..."},
    "target": {"type": "owner", "id": "owner"},
    "emotion": "joy",
    "intensity": 0.82,
    "confidence": 0.91,
    "occurredAt": 1790000000000,
    "halfLifeSeconds": 21600,
    "expiresAt": 1790086400000,
    "sourceRefs": [{"type": "appraisal", "id": "appraisal:88", "role": "evidence"}]
  }
}
```

不传原始私人消息全文；如确需 provenance，传稳定引用和最小摘要。Memory 侧不反向修改 Persona episode；纠错通过新的版本化事件表达。

## 6. 兼容与迁移策略

1. 目标版本暂定 schema v3；实施前必须核对当前 meta 标记与真实结构，不能只看常量。
2. 迁移必须幂等、只增不删、可重复执行；先在临时副本验证 v1/v2/“meta 标记与表结构不一致”三种输入。
3. 老 `emotion_episodes` 统一新增 experiencer=unknown；只有逐条可追溯证据明确证明属于 self/owner 时，才允许后续独立回填，不能批量猜测。
4. 老 target 字段不丢弃；无法映射命名空间的目标标记 unknown。
5. 旧服务 `emotion.state()`、`emotionAt()`、`emotionTimeline()`、旧工具 JSON 形状继续工作；新组合 API 以新增方法暴露，不破坏旧消费者。
6. 新投影先 shadow-only：计算并记录脱敏统计，不改变现有注入；与旧 emotion line 对比后再决定是否接管。
7. Memory inbox/outbox 不在同一 DB 事务中跨库提交；采用 outbox→inbox→ack，事件 ID 幂等，失败可重放。
8. 回滚只关闭新消费者/投影并保留新增表数据；不删除历史事件和来源关联。

## 7. 必须覆盖的测试

- 体验者 self/owner/third_party/unknown 分离；缺字段永远不会默认为 self。
- 同一 target 上正负情绪并存；不同 target 不合并。
- episode 衰减只影响 projection，不修改源对象或 DB 原值。
- expires_at 到期、ended_at 显式结束、重复 end、乱序事件。
- appraisal 与 episode 一对多、多情绪并存、sourceRefs 类型化且 ID 数字碰撞不合并。
- legacy episode 迁移到 unknown，迁移重复运行结果不变。
- 旧 API/工具返回结构兼容。
- outbox 与 episode 同事务；发送失败保留 outbox；重复投递幂等；乱序更新按版本拒绝旧事件。
- memory inbox 不改写事实、不影响召回排序/注入权重，除非后续独立评审授权。
- shadow projection 故障时旧 emotion path 不受影响。

## 8. 分阶段实施

- EI-2A：锁定数据契约与 schema migration；新增字段/表和 migration tests，旧路径不切换。
- EI-2B：接入 appraisal → episode 的事务化写入和 typed source refs。
- EI-2C：实现投影 API，shadow-only，与 EI-1 纯函数对齐。
- EI-2D：outbox/inbox 契约及 persona-memory 隔离集成测试。
- EI-2E：DSHA 隔离副本复验，比较真实历史数据的 unknown/self/owner 分类覆盖率；不改生产。
- EI-2F：经负责人审阅后再讨论生产迁移和注入切换。

## 9. 未决项（不得自行拍板）

1. `owner` 稳定 ID 应使用现有 DSH user ID、persona relationship peer ID，还是独立 UUID；实施前要统一。
2. third_party 去重策略：会话内临时 ID、用户确认联系人 ID，还是不跨会话关联。
3. sourceRefs 中 raw_message/tool_call 的稳定引用由哪个插件提供；不能复制原始正文。
4. Emotion episode 的显式结束条件与默认 half-life/expiresAt 的产品语义。
5. Memory 侧是否仅做关联检索，或允许情绪影响回忆排序；本提案默认只做关联，不改变事实权重、召回排序和自动注入。
6. outbox 重试/保留期与事件纠错/撤回语义。
7. 是否需要保留 legacy confidence threshold 0.65；它是工程影子评估阈值，不是心理学真值。

## 10. 安全边界与本次状态

- 本文件是设计提案，不代表用户已批准 schema v3 或生产迁移。
- 本轮不执行生产 DB 读写，不改 persona.db/memory.db，不改 profile，不部署、不重启。
- 不向 Memory 发送真实情绪数据；outbox/inbox 仅为设计。
- 不把 unknown 自动转换为 self。
- 不将情绪作为记忆事实、授权或行动决策的替代依据。
