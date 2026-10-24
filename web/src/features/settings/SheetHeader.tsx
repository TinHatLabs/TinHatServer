// SheetHeader.tsx — Kirigami.OverlaySheet header as the native draws it: a level-1 Heading
// (16.2 px on the rig) and the Kirigami separator under the header, always visible.
import s from "./SheetHeader.module.css";

export function SheetHeader({ text }: { text: string }) {
  return (
    <>
      <div className={s.title}>{text}</div>
      <div className={s.headerRule} />
    </>
  );
}
