<p align="center">
  <img src="./assets/readme/hero.svg" width="100%" alt="dsh-chem-editor: select a molecular region inside DeepSeek Harness and preview a local edit; the example changes benzene to pyridine">
</p>

# Molecular editing inside DSH

**dsh-chem-editor** is a molecular editor plugin for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness). Select an atom, bond or region, describe a change, and let the current session's Agent propose a local edit. Review the result before applying or cancelling it.

[简体中文](./README.md) · [Installation](#installation) · [First use](#first-use) · [Current scope](#current-scope) · [Validation](./P3_ACCEPTANCE.md)

![The molecular canvas as the main workspace with native DSH chat opened alongside](./assets/readme/workspace-preview.png)

<sub>Official DSH 0.2.0-rc.2 Web environment: real Ketcher / Indigo and native DSH chat. This layout check made no model calls. [Workspace acceptance record](./WORKSPACE_ACCEPTANCE.md).</sub>

## Features

| Operation | Selection | Example instruction |
| --- | --- | --- |
| Replace an element | One ordinary atom | Replace the selected C with N |
| Change bond order | One ordinary bond | Change this single bond to a double bond |
| Attach a group | One atom, or a region with an explicit attachment atom | Add a propyl group here |
| Replace a terminal fragment | Connected selection with one ordinary single-bond exit | Replace methyl with phenyl |
| Compound edit | Frozen selection satisfying every step | Replace O with C, then attach phenyl |
| Delete a region | Atoms, bonds or a rectangular selection | Delete the entire selection and retain the other atoms |

Addition and terminal replacement use fixed **OH, CH3, NH2, F, Cl, ethyl, n-propyl, isopropyl and phenyl** templates with one attachment point. Plain “propyl” means n-propyl, explicitly named in the preview; `C3H7` alone requires clarification. Multi-atom groups are added as one complete fragment and undone in one step. After box selection, choose an attachment atom in the annotation panel; it is frozen when submitting. Bond orders are 1, 2 or 3. Deletion previews list boundary bonds that will be cut.

Also includes manual 2D drawing, SMILES / MOL / KET import, project / KET / MOL V3000 / SMILES / SVG export, automatic persistence and per-session documents. Simplified Chinese is the default; switch to English without reloading the canvas. Chemical identifiers and input data stay unchanged; some engine diagnostics retain their original language.

## Installation

Current version: **0.1.0**. Tested with official DSH **0.2.0-rc.2**, Node.js **24.14.0** and pnpm **12.6.0**. Ketcher core/react/standalone are pinned to **3.7.0**. Other DSH versions have not been validated.

Install Node.js, pnpm and the official DSH app, then clone and build:

```powershell
git clone https://github.com/A7m0spHere/dsh-chem-editor.git
cd dsh-chem-editor
pnpm install --frozen-lockfile
pnpm run build
```

From this directory, install into the Desktop profile. Replace `$dshCli` with your actual DSH installation path:

```powershell
$env:DSH_HOME = Join-Path $env:USERPROFILE '.dsh'
$dshCli = 'D:\dsh\resources\runtime\cli\bin\dsh.cmd'
& $dshCli plugin --profile desktop add (Get-Location).Path
```

Fully quit DSH through its application menu and relaunch to load the host and tools. Desktop uses the `desktop` profile. Source installation links this directory, so keep the checkout.

`lib/` and `dist/` are generated rather than committed. `pnpm pack` builds and packages the runtime assets. No npm package or GitHub Release installer is currently published.

## First use

1. Open a DSH conversation and select **分子工作区** in the sidebar, or click the hexagonal **分子** button beside its title, to enter the main molecular workspace.
2. Load **Benzene**, keep the rectangular selection tool, and click a ring vertex.
3. Wait for **Saved**, enter “Replace the selected C with N”, and choose **Send to Agent**. The session needs a configured, working model.
4. Inspect the before/after preview. **Apply edit** produces pyridine; **Cancel annotation** retains the original.
5. **Undo** restores the original molecule. Manual drawing and Agent edits share one history.

**Replace selected atom** performs a manual element replacement without calling a model. Shortcut buttons fill the instruction; submit it with **Send to Agent**. Select bonds or drag a rectangular region for the other operations.

The canvas is the main workspace. **DSH 助手** opens the current session's native chat as an auxiliary panel; closing it retains its draft. Narrow windows use a drawer. Local editing controls start collapsed and appear when atoms or bonds are selected, or when an Agent preview arrives.

Expand **Import / Open**, **Save and restore**, or **Quick annotations** when needed. Drag the divider or use the arrow keys to resize the tools panel. **Focus canvas** hides the tools; **Fullscreen editor** expands the editor. Toggling auxiliary panels retains the molecule, selection and undo history. **返回 DSH 聊天** leaves the workspace; unsaved changes trigger a save and keep the workspace open until you retry after saving. Reopening restores the saved molecule.

## Controlled local edits

Submission freezes the selection and document version. The Agent reads it through `chem_get_context` and submits one operation through `chem_propose_edit`. A deterministic executor builds a candidate from the frozen KET, checks chemical validity and verifies the edit's scope.

**The canvas stays unchanged during preview. Only your Apply edit action saves the candidate.** Later selections do not retarget an annotation. Document changes, closing the editor or restarting invalidate old previews. Tools do not accept a whole-molecule SMILES replacement. One annotation is active per session.

## Persistence

Molecules, names and interface language save automatically. After **Saved**, reopening the panel, refreshing or restarting DSH restores the document. Sessions have separate documents. Export a `.chem.json` **Project document** to move a structure to another session.

Failed writes retain the original file and show an unsaved state. Export unsaved work before reloading after a version conflict. Undo history lasts only for the current editor lifetime.

Direct sidebar navigation also saves the latest draft before detaching. Reentry waits for pending writes. If the departure save fails, the current client retains and restores the draft while checking its original version token for conflicts.

<details>
<summary>Storage and runtime details</summary>

Workspace sessions use `.chem-editor/<SHA-256 of the session ID>.json`; sessions without a workspace use `chem-editor/documents` under DSH home. Annotation journals retain the last 20 entries. Temporary-file writes, flush, replacement and content-version checks protect persistence. A receipt saved with the document prevents duplicate commits.

Ketcher runs in an isolated iframe. A temporary static server binds only to `127.0.0.1` and closes with the plugin host; Indigo runs in the browser. No separate Python or Indigo Server is required. UI preferences do not replace disk documents.

</details>

## Current scope

The executor, tool schema, Agent context, instructions and shortcuts share one fragment registry. Layout checks the entire added fragment while retaining original coordinates. Unsupported requests or missing attachment points use `chem_reject_edit` to show a concrete reason and next step in the panel. Executor failures also retain their specific cause.

Explicit instructions are checked against the complete plan: methyl cannot substitute for propyl without actual user consent, and a compound request cannot silently be reduced to its first step. `batch.edits` submits 2–8 steps for one validated preview, atomic apply/save, and one-step undo. Unrecognized intent requires clarification. Reply in DSH chat or use “Clarify the edit” / “Continue annotation” in the panel; `chem_continue_edit` checks actual user replies and retains the frozen selection. Applied, cancelled or stale annotations cannot resume.

Terminal replacement requires one non-stereo single-bond exit. Existing aromatic fragments, multiple exits and arbitrary reconnection remain unsupported. Compound steps can target only surviving original frozen IDs, not atoms created by an earlier step.

AI edits target ordinary small molecules. Complex fragment replacement, multiple attachment exits, automatic reconnection, S/R-groups, query or pseudoatoms, reactions and polymer templates are not supported.

Edits to aromatic ring bond orders, aromatic ring deletion and changes affecting adjacent stereocenters are rejected. Overlapping coordinates are rejected when they prevent reliable comparison. Untouched atoms, bonds, coordinates, charges, isotopes and stereo fields are checked; implicit hydrogen counts at declared boundaries may be recalculated.

Unchanged stereo diagnostics from the original structure stay visible in the preview. New diagnostics are rejected. Passing structural checks does not establish synthesizability or verify a molecule's identity from its name.

**Validation:** P0–P3 browser regressions and the real official Web Agent workflow passed. P0–P2 also have native Desktop acceptance. P3 was installed and Desktop fully restarted, but its final native-window click check was blocked by Windows input protection and remains incomplete. See [P3 acceptance](./P3_ACCEPTANCE.md).

The 2026-10-07 complete-edit fix passed 20 unit tests, six browser suites, and real official Web Agent validation of phenyl addition/replacement, compound plans and actual chat continuation. See [complete-edit acceptance](./EDIT_FLOW_ACCEPTANCE.md). The linked Desktop checkout has been rebuilt; Desktop was not restarted or tested natively for these additions in this run. Fully exit and reopen DSH to load the new tools and editor.

## Development and validation

```powershell
pnpm test
pnpm run test:browser
```

Browser tests require installed Chrome. The runner starts an isolated server and cleans up temporary workspaces. All six suites (P0/P1/P2/P3, complete edits/continuation, and responsive layout) must report `ALL-PASS`. Layout checks cover narrow panels, wide windows, the divider, focus mode and iframe fullscreen. Unit tests cover persistence, conflicts, selection boundaries, deletion and idempotent commits.

Real-model tests require a separately configured official DSH temporary Web profile and read its launch URL from an ignored local log. Ordinary tests do not call your model. Run `scripts/*-real-agent-test.mjs` only after configuring that environment. `complete-edit-real-agent-test.mjs` covers phenyl addition/replacement, compound edits and actual chat replies.

- [P0 integration](./P0_ACCEPTANCE.md) · [P1 persistence and Chinese UI](./P1_ACCEPTANCE.md) · [P2 Agent workflow](./P2_ACCEPTANCE.md) · [P3 local operations](./P3_ACCEPTANCE.md)
- [Development plan](./DEVELOPMENT_PLAN.md): P4 scope will be decided separately.
- [Report an issue](https://github.com/A7m0spHere/dsh-chem-editor/issues) with the DSH version, steps and a shareable minimal structure. Exclude credentials and authenticated URLs.

## Licensing and acknowledgements

Project code is licensed under the [MIT License](./LICENSE). [EPAM Ketcher](https://github.com/epam/ketcher) and [Indigo](https://github.com/epam/Indigo) use Apache-2.0; other dependencies retain their own licenses. Third-party notices are preserved in the build.
