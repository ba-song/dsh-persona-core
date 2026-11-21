# EI-REPORT-0005 · EI-2 设计复核裁决与 EI-1 状态收口

> 仓库：`ba-song/dsh-persona-core`
> 分支：`ei/pre-ei2a-review-01`（独立报告分支）
> 任务：`EI-PRE-EI2A-REVIEW-01` 后续 GPT 设计复核
> 更新时间：2026-11-21
> 性质：设计审查与文档修订；不是 EI-2A 实施授权。

## 0. 本轮结论

- EI-1：**代码隔离验收 PASS**，只能表述为“代码隔离验收 PASS，DSHA/负责人设备复验 NOT RUN”。本轮未改 EI-1 源码或测试，也未重新执行测试。
- EI-2：设计中的 B1 confidence 语义、B2 legacy dedupe_key 公式、D3 生命周期优先级已补齐并写入设计文档。
- D2 third_party 临时身份策略、D4 旧 348 条 shadow 规则、D5 阈值定位、D6 legacy fallback、D7 outbox/inbox 阶段边界已形成明确设计裁决。
- D1 owner 稳定 ID 仍保留负责人最终确认；建议跨受信任设备共享的 opaque UUID，不直接绑定 DSH 登录 ID、手机号或外部账号。
- EI-2A 仍为 NOT RUN；没有获得实施授权。

## 1. 基线与证据

| 项 | 值 |
|---|---|
| EI-1 代码验收目标 | `3a1376184491d94b02d4c3ad4990a957e85acb48` |
| EI-1 当前文档分支 HEAD（本轮开始） | `1572e49ce0fd9c713f119ff8300af91db3c2bb1e` |
| EI-1 source blob | `cf033ec8400ea38e717481a46a5bfe834276a4a5` |
| EI-1 tests blob | `eb17cb0f2c67450a145f38d1a582bef6d90b07c8` |
| EI-1 定向测试 | 21/21 pass，0 fail、0 skip（由 EI-REPORT-0004 记录） |
| EI-1 全量测试 | 324/324 pass，0 fail、0 skip（由 EI-REPORT-0004 记录） |
| EI-1 DSHA/生产复验 | NOT RUN |
| EI-2 设计修订提交 | `8ccb8a922a789d8d15157b9d99f9de0c20c8807b` |
| EI-2 设计文档 blob | `670e5a34a1916a8b104ebfd1004b525236677d4c` |
| 设计文件 | `EI-2-PERSISTENCE-DESIGN-01.md` |

EI-1 测试证据沿用 EI-REPORT-0004；本轮没有把文档修订误记为新的 EI-1 代码测试。

## 2. B1：confidence 语义字段

设计文档现已要求 `emotion_appraisal` 与 `emotion_appraisal_items` 均增加：

- `confidence_kind`
- `confidence_source`

`confidence_kind` 允许值：

- `unknown`
- `rule_default`
- `calibrated`
- `legacy_unclassified`

规则默认 0.5 与 0.7 都标记为 `rule_default`，具体数值由 confidence 保存，来源字段记录具体入口/规则；校准值记录模型及版本。缺失置信度标记 `unknown`，不得伪装成已知默认值。旧行统一标记 `legacy_unclassified`，不从旧数值猜测来源。

原 appraisal 旧 confidence 列保留兼容，不在增量迁移中重建。新消费者必须先检查 kind；旧列的兼容占位值不能被当成已知置信度。

## 3. B2：legacy dedupe_key 公式

旧 event 行回填公式冻结为：

`legacy:event:<event_id>`

其中 event_id 取 `emotion_event.id` 的十进制文本。缺失 source_kind 时补 `legacy`，已有非空 source_kind 和 dedupe_key 不覆盖。新写入 trim 外围空白、Unicode NFC 规范化、保留大小写、拒绝空值。

EI-2A 必须用 fixture 证明：
- 旧行 key 唯一；
- 重复执行迁移幂等；
- 已有非空 key 不被覆盖；
- 唯一约束冲突会被明确检测，不静默改写历史 key。

## 4. D3：episode 生命周期

冻结为：

`effective_end_at = min(non-null ended_at, expires_at)`

- 两者都 NULL 时无硬截止；
- 较早者决定退出；
- `end_reason` 只解释显式结束，不延长自然到期；
- half-life 只影响强度衰减，不等同于生命周期硬截止；
- 到期或结束都不物理删除 episode。

## 5. 其他决策

| 项 | 裁决 |
|---|---|
| D1 owner ID | 待负责人最终确认；推荐跨受信任设备共享的 opaque UUID；EI-2A 可先用 unknown/空 ID |
| D2 third_party | 会话内 opaque 临时 ID，不跨会话关联；不读取联系人/通讯录 ID |
| D4 旧 348 条 | 迁移先全部 unknown；known-self/owner/third_party 仅 shadow 统计，不自动升级 |
| D5 0.65/0.45 | 保留为工程 shadow 阈值，明确未校准、非心理学真值 |
| D6 legacy fallback | `stateFor('self')` 可返回旧视图，但必须带 `legacyFallback:true`，不得作为可信 self 注入 |
| D7 outbox/inbox | EI-2A 不建、不运行；DDL、传输、ACK、重试留到 EI-2D |

## 6. EI-2A 最小范围建议

在负责人明确授权后，EI-2A 才能实施：

- persona 本地 schema 增量 DDL；
- migration 脚本；
- 旧结构、部分扩展结构、完整结构三类 fixture；
- 幂等、故障回滚、兼容性测试；
- 旧 API 与旧注入路径不切换；
- 只在临时副本中验证，不写生产。

EI-2A 不包含：
- outbox/inbox 建表或运行；
- appraisal→episode 新写入接入（EI-2B）；
- 新读取 API/投影切换（EI-2C）；
- ACK/重试运行（EI-2D）；
- DSHA shadow（EI-2E）；
- 生产迁移/部署/重启（EI-2F）。

## 7. 门禁与未完成事项

- D1 owner ID 需要负责人最终确认。
- EI-1 DSHA 设备复验仍 NOT RUN。
- EI-2A 实施仍 NOT RUN，必须等待负责人当前对话明确授权。
- 生产 persona.db / memory.db、staging、生产注入、部署、重启均未触碰，仍需单独授权。
- 本轮未修改 Memory 仓库、未修改 EI-1 源码/测试、未修改共享 HANDOFF/REPORT。

## 8. 相关报告

- EI-REPORT-0004：本轮前 EI-1 复核与 EI-2A blocker 审查，位于同分支历史。
- EI-REPORT-0005：本文件，记录 GPT 后续设计裁决。
