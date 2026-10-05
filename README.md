<p align="center">
  <img src="./assets/readme/hero.svg" width="100%" alt="dsh-chem-editor：在 DeepSeek Harness 中选择分子局部并预览修改；示例将苯中的一个 C 改为 N">
</p>

# 在 DSH 中编辑分子

**dsh-chem-editor** 是 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的分子编辑器插件。用鼠标选中原子、键或片段，写下修改要求，由当前会话的 Agent 生成局部修改预览，再由你应用或取消。

[English](./README.en.md) · [安装](#安装) · [第一次使用](#第一次使用) · [当前范围](#当前范围) · [验证记录](./P3_ACCEPTANCE.md)

![阿司匹林的二维画布及在选中碳原子添加 OH 的修改前后预览](./assets/readme/editor-preview.png)

<sub>浏览器验收环境截图：真实 Ketcher / Indigo 编辑器，Agent 使用确定性测试夹具。真实 DSH Agent 验证另见验收记录。</sub>

## 能做什么

| 操作 | 如何选择 | 批注示例 |
| --- | --- | --- |
| 改元素 | 一个普通原子 | 把选中的 C 换成 N |
| 改键级 | 一根普通键 | 把这根单键改成双键 |
| 添加基团 | 一个连接原子 | 在这里添加 OH，使用单键连接 |
| 删除局部 | 原子、键或矩形框选区域 | 删除整个选区，保留其余原子 |

添加基团支持 **OH、CH3、NH2、F、Cl**，每个模板只有一个连接点。改键支持单键、双键、三键。删除预览会列出被断开的边界键。

此外支持二维手绘、SMILES / MOL / KET 导入、项目文档 / KET / MOL V3000 / SMILES / SVG 导出、自动保存和会话隔离。界面默认简体中文，可切换 English；化学符号、输入内容和结构文件保持原样，部分专业诊断保留英文。

## 安装

当前版本 **0.1.0**。已验证环境为官方 DSH **0.2.0-rc.2**、Node.js **24.14.0**、pnpm **12.6.0**；Ketcher core/react/standalone 锁定 **3.7.0**。其他 DSH 版本尚未验证。

先安装 Node.js、pnpm 和官方 DSH，然后克隆并构建：

```powershell
git clone https://github.com/A7m0spHere/dsh-chem-editor.git
cd dsh-chem-editor
pnpm install --frozen-lockfile
pnpm run build
```

在此项目目录执行桌面端安装。将 `$dshCli` 改为你的 DSH 安装路径：

```powershell
$env:DSH_HOME = Join-Path $env:USERPROFILE '.dsh'
$dshCli = 'D:\dsh\resources\runtime\cli\bin\dsh.cmd'
& $dshCli plugin --profile desktop add (Get-Location).Path
```

通过 DSH 的「应用 → 退出」完整退出，再重新启动，以加载插件宿主和工具。桌面端使用 `desktop` profile。源码安装链接到本地目录，请保留该目录。

仓库保存源码和锁文件；`lib/`、`dist/` 由构建生成。需要本地插件包时运行 `pnpm pack`，会自动构建并打包运行资源。当前没有发布 npm 包或 GitHub Release 安装包。

## 第一次使用

1. 打开 DSH 会话，点击标题旁的六边形「分子」按钮，打开右侧面板。
2. 点击「苯」示例，保持矩形选择工具，点击苯环上的一个顶点。
3. 等待状态显示「已保存」，输入“把选中的 C 换成 N”，点击「交给 Agent」。会话需要已配置可用模型。
4. 核对修改前后预览，点击「应用修改」得到吡啶，或点击「取消批注」保留原结构。
5. 点击「撤销」恢复原分子；手工编辑和 Agent 修改使用同一套撤销历史。

「替换选中原子」可以直接做手工元素替换，无需调用模型。批注快捷按钮只填写要求，仍需点击「交给 Agent」。改键时选择一根键，添加基团时选择一个原子，删除时可以框选多个原子和键。

## 修改如何受控

提交时冻结选区和文档版本。Agent 先用 `chem_get_context` 读取对应上下文，再用 `chem_propose_edit` 提交一个局部操作；执行器基于冻结 KET 生成候选，并检查价态、立体信息和修改范围。

**预览期间原画布保持不变，只有你点击「应用修改」才会保存。** 之后选择其他位置不会改变旧批注的目标；结构发生变化、关闭编辑器或重启后，旧预览失效。模型不能通过工具提交整图 SMILES 来覆盖分子。每个会话同时处理一条批注。

## 保存与恢复

结构、文档名称和语言自动保存；显示「已保存」后，关闭重开面板、刷新或重启 DSH 可以恢复。每个会话拥有独立文档。「项目文档」导出生成 `.chem.json`，可带到另一个会话导入。

保存失败会保留原文件并显示未保存状态；发生版本冲突时，可以先导出当前结构，再「重新载入已保存版本」。撤销历史只在当前编辑器运行期间保留。

<details>
<summary>存储位置与技术信息</summary>

有工作区的会话保存到 `.chem-editor/<会话标识的 SHA-256>.json`；无工作区会话使用 DSH 用户目录下的 `chem-editor/documents`。同目录的 `.annotations.json` 保留最近 20 条批注。文档使用临时文件、flush、替换和内容版本检查；应用回执随文档保存，用于防止重复提交。

Ketcher 在独立 iframe 中运行，隔离 React 和 CSS。静态资源服务只绑定 `127.0.0.1`，随插件宿主卸载关闭；Indigo 在浏览器内运行，无需另起 Python 或 Indigo Server。界面偏好不替代磁盘文档。

</details>

## 当前范围

AI 局部编辑面向普通小分子。暂不支持复杂片段替换、多出口连接、自动重连、S-group / R-group、查询或伪原子、反应及聚合物模板。

改芳香环键级、断开芳香体系、影响邻接立体中心的拓扑操作会被拒绝。重叠坐标无法可靠核对时也会拒绝。未修改区域的元素、连接、坐标、电荷、同位素和立体字段受检查；连接边界的隐式氢允许重新计算。

原结构已有且未变化的立体诊断会在预览中显示；新出现的诊断会拒绝。通过结构检查不代表能够合成，也不表示名称与分子身份已核实。

**验证状态：** P0–P3 浏览器回归和真实官方 Web Agent 链路均通过；P0–P2 另有原生 Desktop 验收。P3 已更新到桌面端并完整重启，但最后一次原生窗口点击复验受 Windows 输入保护阻止，尚未完成。详见 [P3 验收记录](./P3_ACCEPTANCE.md)。

## 开发与验证

```powershell
pnpm test
pnpm run test:browser
```

浏览器验收需要已安装 Chrome。脚本自动启动隔离服务器并清理临时工作区；P0、P1、P2、P3 四组均以 `ALL-PASS` 为通过判据。单元测试覆盖存储、版本冲突、选区保护、边界删除和幂等提交。

真实模型测试需要另行启动已配置模型的官方 DSH 临时 Web profile，并从本地忽略的日志读取启动 URL；普通测试不会调用你的模型。未配置真实运行环境时，不直接运行 `scripts/p*-real-agent-test.mjs`。

- [P0 技术验证](./P0_ACCEPTANCE.md) · [P1 保存与中文界面](./P1_ACCEPTANCE.md) · [P2 Agent 闭环](./P2_ACCEPTANCE.md) · [P3 四类局部操作](./P3_ACCEPTANCE.md)
- [开发方案与后续计划](./DEVELOPMENT_PLAN.md)：P4 将另行确定复杂片段替换、多条批注等范围。
- [报告问题](https://github.com/A7m0spHere/dsh-chem-editor/issues)：请提供 DSH 版本、操作步骤和可分享的最小结构样例；不要附带凭据或认证 URL。

## 许可与致谢

本项目代码采用 [MIT 许可证](./LICENSE)。[EPAM Ketcher](https://github.com/epam/ketcher) 与 [Indigo](https://github.com/epam/Indigo) 使用 Apache-2.0；其他依赖遵循各自许可证。第三方许可声明随构建保留。
