# dsh-chem-editor

A molecular editor for the official DeepSeek Harness desktop app. Version `0.1.0` completes P0–P3: bilingual editing, persistence, and annotation-driven local atom, bond, fragment and region operations. [简体中文](./README.md)

Open a conversation and click the hexagonal **分子** button beside its title. The right-hand panel supports Ketcher drawing, SMILES/MOL/KET import, atom selection, validated element replacement, undo/redo, and project/KET/MOL/SMILES/SVG export.

The editor defaults to Simplified Chinese. Choose **English** in the top-right language selector to change the editor's labels and tooltips without reloading the molecular canvas. The translation adapter covers the pinned Ketcher version's common tools and dialogs; chemical symbols, serialized data and engine diagnostics retain their technical identifiers.

Changes are saved automatically. Each conversation has an independent document under its workspace's `.chem-editor` directory. Conversations without a workspace use the DSH home directory. **已保存 / Saved** confirms successful disk persistence. Closing and reopening the panel, refreshing, and restarting DSH restore the saved molecule and document metadata. Undo history and atom selection are limited to the current editor lifetime.

Writes use a temporary file, flush, atomic replacement and a content-version check. Failed writes preserve the original file. Concurrent edits return a conflict; export unsaved changes before reloading the saved version. Corrupt documents are preserved and never replaced with an empty canvas.

Export **项目文档 / Project document** to move a `.chem.json` document between conversations.

Select an atom, bond or box-select a region, enter an instruction and choose **Send to Agent**. The current DSH Agent reads the frozen selection with `chem_get_context` and proposes a local edit with `chem_propose_edit`. The editor checks the candidate and shows before/after images. Only the human's **Apply edit** action commits it; cancelling keeps the original. Subsequent selection changes do not retarget the batch, and document changes invalidate it. Undo uses the existing editor history.

P3 supports one active annotation per session and four operations: element replacement, ordinary bond orders 1/2/3, fixed OH/CH3/NH2/F/Cl attachment through one single bond, and deletion of the frozen atoms/bonds. Deletion previews list boundary bonds. Shortcut buttons fill the instruction before submission. Complex fragment replacement remains P4. Aromatic ring edits, affected stereocenters, overlapping coordinates and unsupported templates are rejected. Existing unchanged stereo diagnostics remain visible in the preview; new diagnostics are rejected. Annotation journals retain the last 20 entries; a durable application receipt prevents duplicate commits. Restart the desktop app after upgrading so its host reloads the tool definitions.

```powershell
pnpm install --frozen-lockfile
pnpm run build
pnpm test
pnpm run test:browser
```

Chrome is required for browser acceptance tests. The test runner manages its own temporary server and workspaces. All P0/P1/P2/P3 suites must print `ALL-PASS`. A separate real-model test has passed using the official DSH runtime and the existing DeepSeek configuration; see `P2_ACCEPTANCE.md` and `P3_ACCEPTANCE.md` for its exact scope.

Compatibility: official DSH Desktop `0.2.0-rc.2`, Ketcher core/react/standalone `3.7.0`, React `18.3.1`. Ketcher and Indigo are Apache-2.0 projects; bundled license comments are retained.

Generated `lib/` and `dist/` are excluded from Git. Build before installing the source checkout as a DSH bundle; `pnpm pack` runs the build and includes these runtime files. Authenticated runtime logs and test workspaces remain local and ignored.
