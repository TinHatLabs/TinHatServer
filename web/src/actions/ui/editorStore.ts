// editorStore.ts — which row editor is open (11.0 buttons): one editor at a time, opened from a row's right-click menu
// ("Edit buttons…"), from Settings → Appearance → Buttons, or from a button island's menu; RowEditorHost (always
// mounted by features/actions) draws it. The desktop's twin: ActionsHost.qml openRowEditor() → RowEditor.qml.
import { create } from "zustand";
import type { FormKind } from "../layoutStore";

export interface RowEditorReq {
  island: string;
  row: string;
  form: FormKind;
  /** the dialog's title ("Room header", "Button island 2" …) */
  title: string;
}

export const useRowEditor = create<{ req: RowEditorReq | null; n: number }>()(() => ({ req: null, n: 0 }));

export function openRowEditor(req: RowEditorReq): void {
  useRowEditor.setState((s) => ({ req, n: s.n + 1 }));
}

export function closeRowEditor(): void {
  useRowEditor.setState({ req: null });
}
