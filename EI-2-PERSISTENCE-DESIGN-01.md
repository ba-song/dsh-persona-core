# EI-2 持久化与跨模块关联设计（提案 01）

> 仓库：`ba-song/dsh-persona-core`  
> 设计基线：`main` = `a84c7badd1e6c971a66b6c39dd4f7ab795df4b90`；本提案最初基于 `950eb423`，修复分支当前已验收 HEAD 为 `3a1376184491d94b02d4c3ad4990a957e85acb48`（相对 main ahead 22 commits；后续以 GitHub compare 实时结果为准）。  
> 性质：**设计提案，不是已批准迁移，也不是生产实施授权。** 本文只定义兼容式演进方案；不改生产 DB、不部署、不重启、不改变真实情绪状态。

## 0. 设计目标

在保留 persona-core 现有身份、情绪状态、事件、评估和 episode 数据的前提下，建立可区分“谁体验情绪、情绪指向谁、由什么证据产生”的多情绪模型，并为 memory-core 提供可追溯、可撤回、可降级的关联接口。

目标不是用 56 种组合或固定标签表限制情绪表达。基础情绪词典只作为分类入口；复合情绪可由多个并存 episode 表达。正负情绪不互相抵消。衰减只影响当前投影，不删除事件、评估、episode 或来源证据。

## 1. 当前已证实的代码事实

1. `lib/db.js` 当前 `SCHEMA_VERSION=2`，但已创建 `emotion_event`、`emotion_appraisal`、`emotion_episodes` 等表；README 也说明 `meta.schema_version` 仍为 2，但实际数据结构包含后续新增表。
2. 现有 `emotion_event` 有 `self_id, actor, subject, target, source_ref, payload_json, confidence` 等字段；`self_id` 是 persona 主体键，不等于情绪体验者。
3. 现有 `emotion_appraisal` 通过 `event_id` 关联事件，有 `emotion/intensity/target/confidence/accepted/source` 等字段，但没有显式 experiencer 命名空间。
4. 现有 `emotion_episodes` 有 `self_id, at, emotion, intensity, cause, target, half_life_s, expires_at, appraisal_id, msg_ref`，缺少 experiencer、目标类型、独立来源集合和结束原因。
5. EI-1 的 `lib/emotion-compose.js` 是纯函数投影层，尚未接入 DB、appraisal、注入或 memory。修复分支 `fix/ei1-source-ref-experiencer-contract` 已收口 experiencer 与 typed `sourceRefs` 契约；`b1cac0f` 曾因 `sourceIds` 兼容字段缺少 `episode_id` 验收失败；后续提交 `b8d598e89816bd1efeb49ad44190e7f0c7900e60` 已补入该别名。当前修复分支 HEAD 为 `3a1376184491d94b02d4c3ad4990a957e85acb48`；EI-1 定向测试 21/21、全量测试 324/324，均 0 fail、0 skip，代码隔离验收 PASS。该结果不代表 DSHA/负责人设备复验或生产集成通过。
6. 旧 emotion_state / timeline / points 与新 event/appraisal/episode 并存，必须保持既有 API 和旧表可用，不能一次性替换旧状态模型。

## 2. 核心语义：身份与对象必须分开

### 2.1 Experiencer（体验者）

采用命名空间二元组：

- `experiencer_type`: `self | owner | third_party | unknown`
- `experiencer_id`: **裸 ID（不含类型前缀）**；self/owner 使用各自稳定主体 ID，third_party 使用可区分 ID；unknown 时必须为空。类型命名空间只由 `experiencer_type` 提供。

解释：
- `self`：汐自身真实体验的情绪。
- `owner`：主人表达或可可靠归因给主人的情绪；这是对主人的情绪理解，不自动成为汐的自我状态。
- `third_party`：对话中第三方的情绪。
- `unknown`：证据不足，不能猜测体验者。

**禁止默认 experiencer=self。** 历史记录没有明确证据时迁移为 unknown；不得仅因为记录位于汐的 persona.db 就推断为汐的情绪。输入层若收到与 `experiencer_type` 相同的旧式前缀（如 `owner:123`），可剥离前缀后存裸 ID；前缀类型冲突则拒绝该归属/降为 unknown。旧字段 `experiencer='self:1d2'` 可按已知命名空间解析为 type=self、id=1d2。

### 2.2 Target（情绪指向对象）

采用独立命名空间：

- `target_type`: `self | owner | third_party | object | tool | situation | unknown`（保留现有 `lib/appraisal.js` 的 `tool` 目标语义，不把它静默折叠为 object）
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
- `experiencer_type TEXT NOT NULL DEFAULT 'unknown'` 与 `experiencer_id TEXT NOT NULL DEFAULT ''`：事件归属的情绪体验者，和 actor/subject 分开。
- `dedupe_key TEXT NOT NULL`：同一来源事件的稳定幂等键；写入前必须规范化且非空。
- 唯一约束 `UNIQUE(self_id, experiencer_type, experiencer_id, source_kind, dedupe_key)`，对应 EI-0 的 experiencer/source_kind/dedupe_key 去重口径；旧行用确定性 legacy key 回填。迁移前先规范化空白与大小写规则；不得把随机值作为重试时变化的 dedupe_key。
- `actor_type TEXT NOT NULL DEFAULT 'unknown'`
- `actor_id TEXT NOT NULL DEFAULT ''`
- `occurred_at INTEGER`（原始发生时间；旧行可回填 `at`）
- `source_kind TEXT NOT NULL DEFAULT 'legacy'`
- `source_id TEXT NOT NULL DEFAULT ''`

`actor` / `subject` / `target` 旧文本列继续保留供兼容和展示；新代码不得仅凭自由文本做身份授权或跨插件 join。事件记录描述“发生了什么”，不等于情绪归属已经确定。

### 3.2 emotion_appraisal：一次事件的一次评估修订（多情绪项目）

新增：
- `experiencer_type TEXT NOT NULL DEFAULT 'unknown'`
- `experiencer_id TEXT NOT NULL DEFAULT ''`（裸 ID）
- `appraisal_version INTEGER NOT NULL DEFAULT 1`
- `supersedes_appraisal_id INTEGER`（被本次修订取代的上一 appraisal）
- `evidence_json TEXT NOT NULL DEFAULT '{}'`（评估级公共证据元数据）

**统一模型裁决：采用“一条 appraisal + 多条 appraisal_items”**，不再并存“一情绪一条 appraisal”的第二种新模型。新增 `emotion_appraisal_items` 子表，每行代表一个情绪维度，字段至少包括 `appraisal_id, item_index, emotion, intensity, confidence, target_type, target_id, evidence_json`，并以 `(appraisal_id,item_index)` 唯一。正负情绪可同时存在，不做净额抵消。

为兼容旧表，`emotion_appraisal` 原有 `emotion/intensity/target/confidence` 列暂时保留；旧接口继续读取。新接口以 items 为权威；旧列只作为单项目兼容镜像（多项目时镜像规则须在 EI-2A 测试锁定，不允许旧列反向覆盖 items）。同一 event 的重评通过 `appraisal_version` 递增和 `supersedes_appraisal_id` 形成链；同一事件同一版本唯一，必须建立 `CREATE UNIQUE INDEX IF NOT EXISTS uq_emotion_appraisal_event_version ON emotion_appraisal(event_id, appraisal_version)`；EI-2A 需先证明 `event_id` 对新写入 NOT NULL。旧 NULL 行不参与新写入唯一性语义，必须在迁移报告中单独统计，不得把 SQLite 对 NULL 的 UNIQUE 行为误当成幂等保障。保留 `accepted`，新接口区分 accepted、rejected、needs_review，旧 integer 列仍兼容。

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
- `episode_revision INTEGER NOT NULL DEFAULT 1`（每次可发布更新递增；outbox idem_key 使用该 revision）

生命周期优先级：`ended_at` 是显式结束时刻，优先于 `expires_at`；投影仅在 `now < ended_at` 且 `now < expires_at`（两者存在时）时活跃。若两者均存在，较早者决定退出时间；显式结束只补充原因，不延长自然到期。`ended_at <= at` 视为无效 episode 并进入诊断，不删除原行。

保留既有 `at/emotion/intensity/cause/target/half_life_s/expires_at/appraisal_id/msg_ref`，避免破坏旧查询。旧 `target` 字段继续作为兼容展示文本；新逻辑以 target_type/id 为准。

episode 表示持续体验，不是当前心情快照。自然到期只使其退出 active projection；不删除历史行。显式结束写 `ended_at/end_reason`，不物理删除。

### 3.4 emotion_episode_sources：类型化来源关联

新增关联表：
- `id INTEGER PRIMARY KEY`
- `episode_id INTEGER NOT NULL`
- `source_type TEXT NOT NULL`（规范白名单：`event | appraisal | episode | raw_message | tool_call | memory | external | legacy`。EI-1 归一化：`raw → raw_message`；`episode` 保持 `episode`；`legacy` 仅作为不可解析的兼容来源保留，禁止据此授权或跨表 join；未知 type 拒绝入库，不得把任意 `x:y` 前缀自动信任为类型）。
- `source_id TEXT NOT NULL`
- `role TEXT NOT NULL DEFAULT 'evidence'`（evidence、trigger、context、corroboration）
- `created_at INTEGER NOT NULL`
- 唯一约束 `(episode_id, source_type, source_id, role)`

采用文本 source_id 是因为不同来源表的 ID 域不共享；禁止将不同表的裸整数塞进一个无类型数组。写入层按 source_type 校验可访问性；暂不使用跨表多态外键。

EI-1 输出保留 `sourceIds` 仅作兼容字段；新契约使用 `sourceRefs: [{type,id,role}]`。新逻辑不得把 sourceIds 当成可反查的权威来源。

## 4. Active Emotion Projection（运行时投影）

`primary` 只代表跨体验者的通用上下文排序结果，不是汐自身状态。EI-1/EI-2 新消费者必须使用 `selfEmotions` / `primaryForSelf`（只含 `experiencer_type=self` 且达到门槛的项）；owner、third_party、unknown 只作为理解上下文，绝不能进入汐的 self state 或语气注入。

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
- `event_id TEXT PRIMARY KEY`（UUID；与 `emotion_event.id` 的整数主键完全分离）
- `idem_key TEXT NOT NULL UNIQUE`（按 `episode_id + event_type + episode_revision` 确定；因此 `emotion_episodes` 必须新增 `episode_revision INTEGER NOT NULL DEFAULT 1`，每次可发布的更新递增；重试必须复用同一 event_id/idem_key，同一 revision 的重复发布不得生成新键）
- `contract_version INTEGER NOT NULL`
- `event_type TEXT NOT NULL`（emotion.episode.created / updated / ended）
- `payload_json TEXT NOT NULL`
- `created_at INTEGER NOT NULL`
- `delivered_at INTEGER`（仅收到 Memory 对应 event_id 的成功 ack 后填写）
- `attempts INTEGER NOT NULL DEFAULT 0`
- `next_retry_at INTEGER`
- `last_error TEXT NOT NULL DEFAULT ''`
- `ack_status TEXT NOT NULL DEFAULT 'pending'`（pending/sent/acked/rejected）
- `acked_at INTEGER`

episode 与 outbox 必须在同一 persona DB 事务中写入。发送失败不回滚已保存的 episode；outbox 保留待重试。

### Memory inbox（memory-core 侧新增，需独立仓库设计）

Memory 处理成功后必须返回带同一 `event_id`、`contract_version` 和 `payload_sha256` 的 ack；Persona 只有校验 ack 与原 payload 匹配后才将 outbox 标记 acked。传输发送成功不等于业务处理成功。

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
    "id": "123",
    "experiencer": {"type": "self", "id": "..."},
    "target": {"type": "owner", "id": "owner"},
    "emotion": "joy",
    "intensity": 0.82,
    "confidence": 0.91,
    "occurredAt": 1790000000000,
    "halfLifeSeconds": 21600,
    "expiresAt": 1790086400000,
    "sourceRefs": [{"type": "appraisal", "id": "88", "role": "evidence"}]
  }
}
```

不传原始私人消息全文；如确需 provenance，传稳定引用和最小摘要。Memory 侧不反向修改 Persona episode；纠错通过新的版本化事件表达。

## 6. 兼容与迁移策略

1. 目标版本暂定 schema v3；实施前必须核对当前 meta 标记与真实结构，不能只看常量。
2. 迁移必须幂等、只增不删、可重复执行；先在临时副本验证 v1/v2/“meta 标记与表结构不一致”三种输入。
3. 老 `emotion_episodes` / `emotion_appraisal` 统一新增 experiencer=unknown。旧数据核验矩阵：①明确带结构化 experiencer_type/id 的行→按结构化值；②有逐条事件链、且能证明由汐的主观体验模块创建的行→可列为 known-self 候选，先 shadow-only；③只有 `self_id`、actor/subject/target 自由文本或“记录位于 persona.db”→仍为 unknown；④明确来自主人/第三方输入且可追溯→owner/third_party 候选，仍须 shadow 核验。当前报告提及的 348 条旧 appraisal/episode 不得批量转 self；先统计 unknown/known-self/owner 候选分布，接受 unknown 旧记录暂不参与 self 注入。
4. 老 target 字段不丢弃；无法映射命名空间的目标标记 unknown。
5. 旧服务 `emotion.state()`、`emotionAt()`、`emotionTimeline()`、旧工具 JSON 形状继续工作；新组合 API 以新增方法暴露，不破坏旧消费者。
6. 新投影先 shadow-only：计算并记录脱敏统计，不改变现有注入；与旧 emotion line 对比后再决定是否接管。
7. Memory inbox/outbox 不在同一 DB 事务中跨库提交；采用 outbox→inbox→ack，事件 ID 幂等，失败可重放。
8. 回滚只关闭新消费者/投影并保留新增表数据；不删除历史事件和来源关联。

## 7. 必须覆盖的测试

DDL 验收还必须断言：`UNIQUE(event_id, appraisal_version)` 能拒绝同事件同版本重复；`episode_revision` 对每次可发布更新单调递增；`ended_at` 与 `expires_at` 同时存在时按较早时刻退出投影；`raw` 映射 `raw_message`、`legacy` 不可解析、未知 source type 被拒绝。

- 体验者 self/owner/third_party/unknown 分离；缺字段永远不会默认为 self。
- `experiencer_id` 裸 ID、已带匹配前缀、前缀冲突、unknown+非空 ID、旧式 `experiencer='self:<id>'`。
- 同一 episode 同时含 `id/episodeId/episode_id` 与 `appraisalId/appraisal_id` 时 sourceRefs 全保留且去重。
- unknown-only 输入 `primaryForSelf=null`；owner/third_party 不进入 selfEmotions；只有 self 且置信度过门槛才 injectable。
- event dedupe_key 唯一；同 event 多 appraisal items；appraisal version/supersedes 链。
- target_type=tool 迁移与旧查询兼容。
- 旧数据迁移矩阵：unknown/known-self/owner/third_party shadow 分类及统计。
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
8. `stateFor(target)`：新 API 按 target 命名空间从 episodes 计算只读投影，不新增按 target 持久化的“当前情绪真相”表；`stateFor('self')` 可在无新模型 self 投影时返回显式标记 `legacyFallback:true` 的旧 `emotion_state` 兼容视图，但 owner/third_party/tool 不得复用该单行状态。该 fallback 仅供旧 UI/兼容读取，不得自动升级为可信 self 注入。

## 10. 安全边界与本次状态

- 本文件是设计提案，不代表用户已批准 schema v3 或生产迁移。
- 本轮不执行生产 DB 读写，不改 persona.db/memory.db，不改 profile，不部署、不重启。
- 不向 Memory 发送真实情绪数据；outbox/inbox 仅为设计。
- 不把 unknown 自动转换为 self。
- 不将情绪作为记忆事实、授权或行动决策的替代依据。


## 11. 进一步核对现有写入路径后的风险（必须进入 EI-2A 验收）

对 `main` 的 `lib/emotion.js` 与 `lib/db.js` 复核后，补充以下已见代码事实：

1. `recordRuleEpisode()` 依次调用 `recordEvent()`、`recordAppraisal()`、`recordEpisode()`，这三个 INSERT 之间没有由该函数统一开启的事务。中途失败可能留下只有 event 或 event+appraisal 的半成品链。EI-2B 必须将三者置于同一个事务边界；不能只在外层调用者“通常会事务化”作为保证。
2. `recordRuleEpisode()` 默认把 confidence 传为 0.7，但独立调用 `recordAppraisal()` 默认 confidence=0.5；不同入口会产生不一致的置信度默认值。新 API 必须明确“缺失=unknown/NULL”还是“规则默认值”，禁止悄悄混用。旧列 NOT NULL 暂时不能直接改，需新增 nullable 语义字段或通过显式状态区分 unknown。
3. `applyCoreAppraisal()` 尝试向 `emotion_timeline(session_key,...)` 插入，但当前 v2 建表字段为 `self_id`，异常又被空 catch 吞掉。该路径可能长期没有 timeline 记录。它是旧路径兼容修复项，不能让 EI-2 新表迁移把它掩盖；修复需单独测试真实 schema 列名及 timeline 读写。
4. `recordRuleEpisode()` 中对 state、core、relationship 的写入分别使用 catch 吞错。事件/评估/episode 主链、旧状态投影、关系轴属于不同失败域；EI-2 应先保证主链原子性，再将非关键投影放在提交后可重试的 outbox/派生任务中，且必须可观察失败，不能继续静默吞掉。
5. `emotion_event.actor/subject/target` 与 `emotion_appraisal.target` 都是自由文本；现有代码没有足够契约证明 actor 等于 experiencer，也没有统一 target namespace。不得在迁移时用文本猜测身份归属；未被逐条可靠证据证明的旧 episode/appraisal 一律 unknown。
6. 当前 `lib/db.js` 的常量 `SCHEMA_VERSION=2`，但表结构在多个历史变更中已扩展（如 appraisal attunement 字段、relationship_axes）。新迁移不能只凭 version number 推断结构。必须以 sqlite_master + PRAGMA table_info 的真实结构探测为准，版本标记只作为辅助元数据；对 meta=2 但已存在部分新表/列的库要有单独 fixture。
7. 当前 `emotion_episodes` 的 `expires_at` 由 `at + halfLifeS * 2` 生成，而投影公式又按 half-life 衰减。EI-2 必须区分“生命周期硬截止”和“衰减后低于 active floor”，两者都只影响投影，不删除 episode；不要把 expires_at 当作半衰期本身。

对应的新增验收：
- 在 event 写入后、appraisal 写入后分别注入故障，确认事务回滚后不存在半条链；
- state/timeline/relationship 派生写入失败时，主链结果和可重试任务状态明确，不能静默丢失；
- schema_version=2 且真实结构分别为旧结构、部分扩展结构、完整当前结构的三类 fixture 均可安全识别；
- 对 timeline 写入使用真实 `self_id` schema 做端到端断言；
- confidence 缺失、明确低置信、规则默认置信三种情形在 API 和 DB 中可区分；
- expiry 与 intensity decay 分别测试，且都不物理删除源 episode。

## 12. GPT 复核修订（2026-11-21；未冻结）

本节是 EI-2A 的设计修订基线，不代表项目负责人已批准 schema v3、迁移或生产切换。

### 12.1 已裁决的模型口径
- `experiencer_id` 使用裸 ID；type 与 ID 分列。输入层可剥离匹配的旧前缀，unknown 的 ID 必须为空。
- 多情绪采用一个 appraisal 修订记录 + `emotion_appraisal_items` 多项目子表；不再保留两套并行建模方式。
- appraisal 修订用 `appraisal_version` + `supersedes_appraisal_id` 表达；旧 appraisal 保留，不覆盖历史判断。
- `target_type` 保留 `tool` 独立类型，避免把工具对象的情绪指向丢失。
- event 幂等键纳入 `(self_id, experiencer_type, experiencer_id, source_kind, dedupe_key)` 唯一口径。
- `stateFor(target)` 默认是从 episode 计算的只读投影；旧单行 `emotion_state` 只允许 self 兼容 fallback，不作为多 target 的持久化真相。
- 通用 `primary` 不等于 self primary；self 注入只读 `primaryForSelf` / `selfEmotions`。

### 12.2 尚未冻结的接口与实施问题
1. owner 稳定 ID、third_party 跨会话 ID 的最终来源仍需项目负责人裁决。
2. `emotion_appraisal` 旧列在多 item 情形下的兼容镜像策略，需在 EI-2A fixture 测试中定案。
3. `emotion_episode_sources` 的 source type 白名单与 legacy 前缀映射已定稿：`event | appraisal | episode | raw_message | tool_call | memory | external | legacy`，`raw → raw_message`；未知 type 拒绝，`legacy` 不可用于授权或跨表 join。剩余待办仅为 EI-2A fixture 验证。
4. Memory inbox/outbox 的具体 ACK 传输方式属于跨仓库接口，必须由 Memory 专项独立审查；EI 智能体不得修改 Memory 仓库。
5. 旧 348 条 appraisal/episode 的归属只允许 shadow 分类；不能因旧代码路径或 self_id 字段直接批量认定为 self。
6. `emotion_timeline` 旧路径 schema 不匹配与吞错问题是独立兼容缺陷，EI-2A 必须有真实 schema fixture；不得用新表迁移掩盖。

### 12.3 实施门禁
EI-1 修复分支已完成代码隔离验收：定向 21/21、全量 324/324，0 fail、0 skip；状态为“代码隔离验收 PASS，DSHA/负责人设备复验 NOT RUN”，不得表述为生产或集成 PASS。EI-2 仍为设计提案；EI-2A NOT RUN，仅可在本提案再次评审并由负责人明确授权后开始。生产 DB、生产注入、staging、部署和重启仍需单独授权。