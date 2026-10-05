# dsh-chem-editor 开发方案

日期：2026-10-05。状态：P0/P1/P2 已实现并通过浏览器、真实 DSH Agent 与官方桌面端验证，详见 [P2_ACCEPTANCE.md](./P2_ACCEPTANCE.md)。P3 的四类操作已实现；最新验证见 [P3_ACCEPTANCE.md](./P3_ACCEPTANCE.md)。P4 为后续提案。历史记录见 [P0_ACCEPTANCE.md](./P0_ACCEPTANCE.md) 和 [P1_ACCEPTANCE.md](./P1_ACCEPTANCE.md)。

## 产品目标

在 DeepSeek Harness 内提供可交互的二维分子编辑器。Agent 创建结构，用户用鼠标选择原子、键或局部片段并添加批注，Agent 通过受约束的结构操作修改对应位置，用户可以查看结果、撤销和导出。

方案基于聊天「DSH插件化适配分析」中的五轮讨论。需求已经从 CDXML 工具适配转为可视化选区与 Agent 的交互；不沿用早期以 ChemDraw/CDXML 为核心的路线。

首版支持普通小分子，包括多环、多支链结构。复杂度优先用真实样例验证，不承诺所有复杂结构均可编辑。反应、聚合物、查询原子和复杂 S-group 的 AI 修改不在首版范围；遇到不支持的对象明确返回原因，不能静默丢弃信息。

## 用户流程

1. 在聊天中要求 Agent 创建分子，或打开 MOL/KET、粘贴 SMILES。
2. 右侧「分子」面板显示二维结构，支持放大编辑和恢复聊天视图。
3. 用户点击原子、键或框选局部，点击「添加批注」。
4. 显示选区高亮和批注输入框，同时提供「改成 N」「添加 OH」「添加 CH3」「改成双键」等快捷操作。
5. 用户提交批注后，插件冻结结构版本和选区，随这条用户消息提供结构化引用。
6. Agent 读取对应快照，调用编辑工具；执行器生成候选结果，验证后显示修改前后预览。
7. 用户应用或取消；应用产生一个完整撤销步骤。快捷操作可直接复用执行器，无需调用模型。

MVP 同时只处理一条批注；多条批注编号、批量执行和通用片段替换后续增加。首次绘制允许 Agent 提交 SMILES；已有分子的局部修改必须使用 patch。

## 技术选型

| 层 | 选型 | 职责 |
|---|---|---|
| 插件宿主 | TypeScript + Cordis + DSH 原生工具 | 文档、会话范围、工具注册、持久化 |
| 浏览器 UI | React + TypeScript，遵循 DSH client 插件构建约定 | 面板、批注、结果预览 |
| 编辑器 | ketcher-react + ketcher-core | 二维绘图、鼠标选择、编辑历史 |
| 化学操作 | ketcher-standalone / Indigo WASM | 格式转换及可用的结构检查 |
| 文档格式 | KET + 插件元数据 | 保留二维信息及结构对象 |
| 工具协议 | 小型、带版本号的 JSON Schema | 限制允许的编辑操作 |
| 包管理 | pnpm | 锁定依赖、可复现构建 |
| 验证 | 单元测试 + 浏览器集成测试 + 实际 DSH 验收 | 检查 patch、选区对应关系与运行链路 |

初期不引入 Python、FastAPI、独立 Indigo Server 或 MCP。RDKit 保留为以后需要更强验证、描述符或子结构搜索时的可选适配器。模型沿用 DSH 当前会话配置。

必须选定并锁定一个可兼容的 DSH 版本，以及配套的 Ketcher 三个包版本。不能直接把上游 master 的 API 当作已安装版本的合同。

## 架构与运行边界

```text
DSH Agent ── 原生工具 ── 宿主 MoleculeService
                              │
                     会话范围的命令/结果桥
                              │
批注 UI ── KetcherAdapter ── Ketcher + Indigo WASM
                              │
                    候选 patch / 检查 / 撤销
```

宿主入口负责工具和文档服务；client 入口负责 UI 和编辑器。浏览器侧的 Ketcher 实例不是宿主工具可以直接读取的全局对象。

桥接优先使用目标 DSH 版本已有的类型化 client/host 通信机制；具体服务、事件名称在 POC 中确认，不在方案中虚构。每次请求携带 sessionId、documentId、baseRevision、requestId 和编辑器实例标识。浏览器返回候选结构和检查结果，宿主按版本提交并广播。

首版化学引擎运行于浏览器：面板未就绪时编辑请求返回 editor_unavailable，不能无限等待。折叠、切换会话、关闭标签、重载和插件卸载均有明确的完成或取消行为。增加超时和取消传播；同一文档串行提交，不同会话状态隔离。

DSH 官方当前文档给出的接入点：

- package.json 声明 dsh.client，并导出 ./client。
- ctx.sidebarRightTabs.register 注册分子 tab 类型。
- ctx.slots.register 注册 sidebar.right.pane.tab 的内容。
- ctx.sidebarRight.openTab 打开面板。
- 宿主 ctx.tools.register 注册模型可见工具。

上述名称来自官方当前文档，实施时仍需在目标版本验证。面板关闭和重开不能丢失文档；面板是否保持挂载由内存占用与就绪状态决定，持久化不依赖组件生命周期。

## 最重要的数据合同

MoleculeDocument 至少包含 schemaVersion、documentId、sessionId、revision、KET、编辑器版本及必要元数据。SMILES 是交换和导出格式，不能作为唯一文档状态。

SelectionSnapshot 至少包含 selectionId、documentId、baseRevision、选中的 atoms/bonds、邻接环境、选区边界连接和批注文本。

Ketcher 的运行时 ID、KET 数组位置和导出的 atom index 不能默认等同。适配层负责映射，在 POC 中验证导入、删除、重新布局、撤销和重载后的对应关系。

首版采用“版本范围内的目标引用”：引用必须与明确的 revision 绑定。结构发生任何修改，旧选区和旧候选方案都失效并要求重新选择；不靠启发式猜测复用旧 ID。暂不承诺跨版本永久原子标识。以后需要长期批注时再引入稳定 ID 与重映射合同。

提交批注时冻结选区；Agent 执行时不能改读用户后来选中的另一处。完整 KET 留在文档服务，模型首先获取选区、邻域、边界和整体摘要，需要时通过工具读取快照中更多结构信息；模型不依赖 SMILES 字符位置定位原子。

## MVP 编辑能力

| operation | 首版合同 |
|---|---|
| replace_atom | 修改选中的单个原子元素；电荷和氢信息必须显式处理或保持后校验 |
| change_bond | 修改选中的键级；不自动大范围重写芳香体系 |
| attach_fragment | 在明确的选中原子连接白名单基团，基团模板具有明确连接点和键级 |
| delete_selection | 删除确定的原子或键集合，并显式列出被移除的边界连接 |

基团先支持 OH、CH3、NH2、F、Cl 等少量模板。OH 不能当作任意 SMILES 字符串拼接，也不能把“替换为 OH”一律解释为“添加 OH”。存在替换/添加或连接点歧义时，给出具体候选或请求补充目标。

复杂片段替换暂缓，尤其是具有两个以上连接出口的片段；它需要单独的接口来描述旧边界到新连接点的对应关系。

拟议工具名称（项目自身设计，并非 DSH 现有 API）：

- chem_create_document：新建并显示分子。
- chem_get_context：读取指定文档版本和批注快照。
- chem_propose_edit：提交受限制的 patch，返回候选方案、图结构差异和检查结果。

“应用”“取消”“撤销”由 UI 调用同一文档服务。第一版不让模型自动跳过预览提交方案。

## 事务、检查与历史

所有 AI patch 先在副本上执行；采用 Ketcher 的 Action/Command 历史机制，避免直接改内部 Struct。若所选版本无法干净复用历史，可统一使用文档快照历史，但必须验证手动编辑与 AI 修改连续撤销，不能产生两套互不一致的历史。

执行顺序：验证 schema → 检查目标版本/冻结选区 → 执行候选 patch → 结构检查 → 比较影响范围 → 返回预览 → 提交时再次检查 revision → 原子化应用。

未选区域的元素、连接关系、电荷、同位素、芳香性和立体信息必须保持。删除和添加允许改变明确声明的边界键及连接原子的氢数/价态；“只改选区”不能误解为边界完全不受影响。若改变造成邻接立体中心失效，首版拒绝并解释，不自动抹除。

首版即包含格式检查、目标存在性、价态检查及芳香/立体信息保留。Indigo 在选定版本可提供的具体检查项需要 POC 核实；无法覆盖的类别限制支持范围，必要时提前增加 RDKit，而不是延期全部验证。

结构检查通过只表示通过所声明的结构规则，不能在 UI 中显示成“保证稳定、可合成或符合预期”。名称生成结构的化学身份正确性也不同于结构可解析，首版显示结构来源，用户可以检查后继续编辑。

失败不修改文档；同一 requestId 重试不重复添加基团；预览过期拒绝应用。宿主为同一文档串行提交，防止用户手动编辑、模型工具和多窗口覆盖彼此。

## 存储与导出

通过 DSH 已有 workspace 文件能力保存 .chem-editor/<documentId>.json，包含 KET、版本和批注。会话记录引用文档标识与 revision，必要的恢复快照按所选宿主合同实现。localStorage 只保存 UI 偏好，不作为分子唯一存储。

保存采用临时文件加原子替换；写入失败显示未保存状态。刷新恢复结构和元数据，历史可在首版仅保留当前运行期间，但必须明确这一边界。

首版导入 SMILES、MOL、KET；导出 SMILES、MOL V3000、SVG 和原生项目文档。CDXML、PNG 等后续按实际需求增加并验证，不预先承诺所有格式无损互转。

## 开发顺序与完成判据

| 阶段 | 工作 | 完成判据 |
|---|---|---|
| P0 技术验证 | DSH 加载、嵌入 Ketcher、读取选区、代码改一个原子、桥接、撤销 | 苯选 C 改 N；多环含手性样例只改目标；撤销恢复；ID 与快照对应；WASM/CSS/模板可加载 |
| P1 基础编辑器 | 导入、手工编辑、持久化、导出、会话隔离 | 刷新能恢复文档；关闭重开不丢失；切换会话无串用 |
| P2 核心 Agent 闭环 | 单条批注、冻结选区、replace_atom、预览、验证、撤销 | 实际 DSH 对话完成选区修改；旧版本 patch 拒绝；失败不污染画布 |
| P3 v0.1 MVP | change_bond、白名单 attach_fragment、delete_selection、框选 | 四类操作通过复杂样例；边界变化可解释；连续手工/AI 撤销正确 |
| P4 后续增强 | 多条批注、复杂片段替换、按需要增加 RDKit 和名称解析 | 在 v0.1 验收后另行确定范围 |

P0 不通过就先解决适配问题，不继续铺完整产品。选区和原子级编辑若需要内部 API，集中在 KetcherAdapter，锁定版本并做兼容检查；确需修改上游时维护最小补丁或贡献上游，不先 fork 全编辑器。

P0 通过后再给 P1–P3 估时；主要不确定性是版本适配、原子映射、编辑历史和 WASM 资源加载，而非 UI 页面数量。

## 验收测试

- 单元测试：patch 范围、基团连接点、删除边界、错误价态、立体信息保留、过期引用、原子化失败和重复请求。
- 浏览器集成：点选/框选、批注时冻结选区、手动编辑后旧请求拒绝、预览、应用、手动与 AI 连续撤销、导出后重载。
- DSH 实际运行：Agent 创建 → 鼠标选择 → 提交批注 → 工具调用 → 预览 → 应用 → 撤销；验证会话切换、面板重开及资源加载。
- 样例覆盖：苯/吡啶、阿司匹林、含酰胺支链分子、多环含手性药物结构、非法价态、多个边界连接片段。

仅源码检查或工具 mock 通过不能替代实际 DSH 操作验收。Web 先验证闭环；Desktop 在目标用户运行环境验证后才声明支持。

## 建议代码组织

```text
src/
  index.ts                 # 宿主入口
  client.tsx               # DSH client 入口
  host/                    # 文档服务、会话范围、工具、桥接、存储
  contracts/               # 文档、选区、patch、错误码
  chemistry/               # patch 范围规则、基团模板、验证合同
  adapters/ketcher/        # ID 映射、selection、Action、历史、Indigo
  ui/                      # 面板、选区栏、批注栏、结果预览
tests/
  fixtures/
  unit/
  integration/
```

同一个插件包包含宿主和 client 入口；暂不拆成多个 npm 包。对外只稳定 document/selection/patch 的小型合同，未验证的实现细节不承诺兼容性。

## 官方依据与待验证项

已核对官方文档：

- [DSH client 模块声明和加载](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/subsystems/client-modules.md)
- [DSH 右侧面板扩展](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/client/ui-sidebar-right/README.md)
- [DSH 工具注册与 schema](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/core/tools/README.md)
- [Ketcher React standalone 接入](https://github.com/epam/ketcher/blob/master/packages/ketcher-react/README.md)
- [Ketcher 结构和事件 API](https://github.com/epam/ketcher)
- [Ketcher 编辑引擎与 Action/Command 约束](https://github.com/epam/ketcher/blob/master/.memory-bank/modules/editor-engine.md)

上述文档证明路线具有实现基础，不证明插件已经可运行。选定发布版本的 selection API、ID 导出映射、程序化编辑与撤销、DSH 通信通道、Indigo 检查覆盖、浏览器静态资源路径均需 P0 实际验证。
