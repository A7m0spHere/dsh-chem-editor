# P3 验收记录

最新完整计划、苯基替换与聊天续接修复见 [EDIT_FLOW_ACCEPTANCE.md](./EDIT_FLOW_ACCEPTANCE.md)：20 项单元测试、六组浏览器验收和真实官方 Web Agent 验收通过。下面保留初次丙基扩展和 P3 初版的历史记录。

## 2026-10-07：多原子基团与批注反馈修复

本轮为 `0.1.0` 的源码修复。基团注册表增加乙基、正丙基、异丙基，模板声明原子、内部键和唯一连接点。工具 schema、Agent 上下文/提示词和快捷批注统一读取注册表。中文别名可直接提交；“丙基”按正丙基生成，预览显示明确名称，`C3H7` 单独使用需澄清异构体。

框选范围与连接点分开：多原子选区在批注区指定一个连接原子，提交时一起冻结；未指定时给出具体处理办法，不再默认使用框选的第一个原子。完整基团旋转/镜像寻找可用空间，检查所有原有组件和键，不移动原有坐标。新增 `chem_reject_edit` 让 Agent 将不支持或需要澄清的原因写入面板；执行器失败原因在回合结束后保留，同回合纠正参数成功则清除旧错误。

当前验证：

- 构建通过；13 项单元测试全部通过，包括正/异丙基拓扑、隐式氢、未选结构保护、冻结连接点、空间不足、具体失败原因及重试只添加一次。
- P0、P1、P2、P3 和主工作区响应布局浏览器验收均返回 `ALL-PASS`。P3 新增八种基团、框选后指定非首个连接点、异步改选保持原连接点、一步撤销，以及不支持基团的面板反馈。
- 隔离的官方 DSH Web 中由真实 Agent 处理“加一个丙基”和“添加异丙基”，核对三碳链/支链结构，预览保持原画布，应用并保存后一步撤销恢复；“添加苯基”通过 `chem_reject_edit` 在面板给出具体原因，原画布保持。最终判据：`ALL-PASS: real DSH Agent propyl/isopropyl preview/apply/save/undo and rejection feedback`。

真实验证脚本：`scripts/fragment-real-agent-test.mjs`。本地证据：`test-results/propyl-real-agent.json`、`propyl-real-normal-preview.png`、`propyl-real-iso-preview.png`；正常丙基批注 `c72909e5-d61a-4cac-bf92-e4c9c5da24c5`，异丙基批注 `92488dff-c502-4b72-95b4-5c8d84e109a5`。临时 Web 服务已停止，凭据副本已清空；验证 HOME 移入本地忽略的 `test-results/propyl-validation-profile` 存档。

Desktop profile 当前链接此源码目录，构建已更新；本轮没有重启用户正在使用的 Desktop，也没有做新增能力的原生窗口验收。需完整退出并重新打开 DSH 加载新宿主工具和编辑器。

## 2026-10-05：初版验收

日期：2026-10-05。版本：`dsh-chem-editor 0.1.0`。

## 实现

在 P2 的冻结选区、人工预览、会话隔离和原子保存基础上，完成四类局部操作：

- `replace_atom`：一个普通原子的元素替换。
- `change_bond`：一根普通键改为单键、双键或三键。
- `attach_fragment`：在一个原子上以单键连接固定 OH、CH3、NH2、F、Cl 模板。
- `delete_selection`：删除冻结的原子和键集合，连同被删原子的关联键；明确列出跨越选区的边界键。支持真实鼠标框选、键选区、孤立片段和清空画布。

工具只接收操作参数，不能接收任意 SMILES 或候选图。共享执行器从冻结 KET 生成候选；浏览器执行 Indigo 检查，宿主核对允许的变化，并在应用时重新检查版本和范围。拓扑操作进入 Ketcher 的 CanvasLoad Action 历史，临时执行成功且原子保存完成后才提交该撤销步骤；保存失败逆转 Action，保留原画布与历史。

快照通过仅用于克隆的 AAM 标记建立运行时 ID 到 KET 地址的映射，验证全部原子和有向键。选区在开始读取异步结构前冻结，提交过程中后来点击别的位置也不改变连接点。删除造成的组件拆分和重新编号通过原子坐标及全部化学属性的图比较核对。

未修改区域的坐标、元素、电荷、同位素和立体字段保持；连接边界的隐式氢允许由化学引擎重新计算。`selected`、空的显示数组和 `stereoFlagPosition` 是显示信息，不作为化学变化。其他元数据不能静默丢弃。

## 自动验证

`pnpm test`：8 项测试通过。新增覆盖模板单连接点、键级与有向端点、边界删除、组件重编号、省略空键数组、立体保护、芳香键保护、全部删除、未选同位素保护、重复预览和幂等提交。

`pnpm run test:browser` 完整回归的最终判据：

```text
ALL-PASS: P0 browser acceptance
ALL-PASS: P1 persistence and Chinese UI acceptance
ALL-PASS: P2 UI/tool bridge acceptance (deterministic model fixture)
ALL-PASS: P3 browser acceptance
```

实际浏览器使用 Ketcher/Indigo 和文件存储，覆盖含酰胺的支链样例、含手性多环样例、五种基团、单/双/三键、内部原子删除、两个边界切断、键删除、孤立原子、真实矩形框选、整图删除、预览保留原图、未选原子的立体属性、提交失败回滚、重试只添加一次、连续手工/AI 撤销、非法价态、芳香环改键拒绝和中英文切换。

最后增加了异步提交期间改选连接点的检查，并重新运行 P2/P3 链路。结构实际仍连接到初始冻结原子。

`pnpm pack` 成功：包内包含 host/client、独立编辑器 JS/CSS/HTML 和 bundle patch。源码仓库忽略构建物、本机日志、文档存档和带认证 URL 的运行记录；安装源码需要先构建。

## 真实 DSH Agent

通过官方 DSH `0.2.0-rc.2` 支持的临时 Web profile，使用既有 DeepSeek-V41-Flash / High 配置，在新验证会话中对 `CCCO` 分别执行添加 OH、单键改双键、删除内部碳及两根边界键。

每个操作都由真实 Agent 读取上下文并提交操作参数，生成预览；确认原画布不变后应用、保存、撤销并比较完整结构。最终判据：

```text
ALL-PASS: P3 real DSH Agent attach/bond/delete preview/apply/save/undo
```

本地证据：`test-results/p3-real-agent.json` 和三张预览截图。通过的批注分别为 `abe3d3e8-5bb8-4e27-bacb-f0dd142d9feb`、`08103d0a-11f5-4eda-bad3-8eeea2de35cd`、`653b3384-1280-49e3-bdfc-b7b6b5ccd23e`。

首轮真实 Agent 删除测试发现孤立原子节点省略空 `bonds` 时校验器异常。已按 KET 的可省略空集合处理，补上单元及浏览器用例；第二轮真实 Agent 的三类操作全部通过。临时 Web 服务已停止，临时 profile 保留在本地测试归档中。

## 官方桌面端与当前边界

本机官方 Desktop profile 仍链接此源码目录，构建已更新为 `0.1.0`，并通过应用菜单完整退出后重开。重开后的原生窗口恢复到既有分子验证会话。

本轮最后的原生窗口点击复验没有完成：Windows 输入保护先后返回 `coordinate input geometry is unavailable`、窗口最小化和 `user input was detected in this window`。遵守 computer-use 的恢复限制后停止继续抢占输入。因此本记录确认更新与重启、浏览器与真实官方 Web Agent 链路；不把这些结果写成 P3 原生窗口应用验收。P0/P1/P2 的原生 Desktop 验收仍见各阶段历史记录。

AI 拓扑操作暂限普通小分子；不支持 S/R-group、查询或伪原子、反应/模板连接、影响邻接立体中心的操作、芳香环键级修改或断开芳香体系。重叠坐标无法可靠核对时拒绝。原结构已有且没有变化的立体诊断在预览中保留显示；新增诊断拒绝。复杂片段替换、自动重连、多出口模板留到 P4。

撤销历史限当前编辑器生命周期；重开仍通过 P1 存档恢复分子。结构检查表示通过声明的检查项，不承诺可合成性或任意复杂分子的适用性。
