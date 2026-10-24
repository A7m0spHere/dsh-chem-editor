# A2 动态片段验收

日期：2026-10-24。范围：固定片段与动态片段统一归一化为 FragmentSpec（显式连接点）、严格 SMILES 子集解析器、统一局部布局与执行、v1/v2 工具接入。规划与完成判据见 [Agent 融合架构规划](./AGENT_ARCHITECTURE.md) 第 6、10 节。

## 交付

| 模块 | 职责 |
| --- | --- |
| `src/contracts/fragment.ts` | FragmentSpec（固定模板 ID / 带显式连接点的片段 SMILES）、统一 ParsedFragment 图、运行预算（≤12 原子、≤1 环、环 3–8 元） |
| `src/chemistry/fragment-spec.ts` | 严格 SMILES 子集解析（元素白名单、括号电荷/同位素/氢、芳香小写原子、环、分支）、价态推导隐氢、连接键计入附着原子价、相对二维局部布局（链锯齿 + 环正多边形 + 前向 120° 分支）、命名动态基团注册（氰基/乙酰基/苄基）、合并目录 |
| `src/chemistry/molecular-patch.ts` | attach/replace 统一走 resolvePatchFragment；执行器消费 ParsedFragment；片段原子支持 charge/isotope；模板基团与显式 connection 互斥 |
| `src/chemistry/fragment-layout.ts` | fragmentPositions 直接接受 ParsedFragment（固定表与动态片段同一布局合同） |
| 工具与提示 | v1 `chem_propose_edit` 与 v2 草稿编辑的 fragment 参数开放为「命名 ID/别名或带 [*] 的片段 SMILES」+ 新增 fragmentConnection{atom,bondType}；意图校验、提示词、面板快捷按钮与 fragmentTemplates 目录同步 |

动态片段必须显式声明连接点（[*] 标记或 fragmentConnection）；不以解析后的第一个原子作默认连接点。连接键级计入附着原子价态，与手写固定模板语义一致。

## 引擎探针（scripts/fragment-probe.mjs，纳入回归）

对锁定的 Indigo WASM 逐项验证：SMILES→带属性片段图（标签/电荷/同位素保留）、芳香小写输入以 type 4 芳香键保留、`layout()` 生成统一键长坐标、畸形输入报错、执行器构造风格的候选通过 `check()`。两条关键结论写入实现约束：**哑原子（[*]/[R1]）经引擎往返丢失标签**，连接点映射必须由我方解析器显式声明；**引擎对垃圾输入宽松解析**（"XyZ" 不报错），元素白名单与价态校验由 chemistry 层严格承担。生产解析不依赖引擎。

## 验证（2026-10-24 全量）

- `pnpm run check:types`：通过；`check:architecture`：通过，33 个模块、95 处导入/导出（A1 时 31/92）。
- `pnpm test`：30 项通过（A1 时 24；新增 6 项：命名动态基团解析与氢、单位键长布局无重叠、括号属性、严格性拒绝（垃圾输入/断开组分/未闭合环/缺连接点/两位环标/裸芳香原子/预算）、附着/替换执行与幸存者属性、意图识别）。
- `pnpm run test:browser`：九组全部 `ALL-PASS`。新增 `scripts/dynamic-fragment-browser-test.mjs` 覆盖真实 Ketcher/Indigo：命名氰基附着（C#N 三键）、原始 SMILES 乙酰基（[*]C(C)=O，经真实意图链）、v2 草稿动态乙酰基、苄基末端替换（芳香环 type 4 保留）；均验证暂存期间原画布不变、一次应用、一步撤销。
- 回归适配：p3 的"不支持基团反馈"样例由苄基改为硝基（苄基现为受支持基团）；v1 工具 fragment 参数由枚举改为开放字符串属合同变更，`tests/host.test.mjs` 同步断言新合同。

对照第 10 节 A2 完成判据：固定表之外的氰基/乙酰基/苄基连接与替换（浏览器四场景）；属性与连接点正确（括号属性单测、执行器保留幸存者属性）；其余结构及坐标保留（各场景 survivors 深比较）。

## 当前边界

解析子集限普通小分子片段：元素白名单 C/N/O/S/P/F/Cl/Br/I/B/Si，单环 ≤8 元，无多环/螺环/稠环，无两位环标记，无 disconnected 组分；多出口替换、S-group/R-group 维持不支持。真实官方 Web Agent 与 Desktop 原生验收按项目决定并入各阶段完成后的总验收，完成前不声明该链路已验证。
